"""Camera motion classification from optical flow.

This module is what separates a useful harness from a shallow one. Hard-cut
detection tells you the picture changed; it cannot tell you how the camera moved.
Without motion analysis the `camera.motion` field in the final prompt can only be
guessed, and camera movement is one of the highest-signal attributes in any
video generation prompt.

Method: dense Farneback optical flow between consecutive sampled frames, then
classify the resulting flow field by its statistical signature.

- Uniform flow with a consistent direction        -> pan / tilt
- Radial outward flow from the centre             -> dolly in / zoom in
- Radial inward flow toward the centre            -> dolly out / zoom out
- Low magnitude, low consistency                  -> static
- High magnitude, low consistency                 -> handheld or subject motion

Farneback rather than RAFT: it runs on CPU in milliseconds per pair, needs no
model download, and is accurate enough for 12-way classification. RAFT earns its
cost only when you need per-pixel flow for subject-motion separation, which the
prompt contract does not require.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from vrh.contracts.segment import MotionDescriptor

log = logging.getLogger(__name__)

try:
    import cv2

    _CV2_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without the media extra
    _CV2_AVAILABLE = False


class MotionAnalyzer:
    """Classifies camera motion from a sequence of frames on disk."""

    # Classification thresholds. Exposed as attributes so they can be tuned per
    # corpus without editing logic.
    static_threshold = 0.005
    handheld_consistency = 0.35
    radial_threshold = 0.30

    def __init__(self, target_width: int = 320) -> None:
        # Downscaling before flow estimation cuts cost ~8x with negligible
        # accuracy loss: we only need coarse directional structure.
        self.target_width = target_width

    def analyse(self, frame_paths: list[Path]) -> MotionDescriptor:
        """Classify motion across the supplied frames.

        Requires at least two frames. With fewer, motion is unknowable from
        imagery alone and we return `unknown` rather than asserting `static`.
        """
        if not _CV2_AVAILABLE:
            log.debug("opencv unavailable; motion analysis skipped")
            return MotionDescriptor(dominant="unknown")

        images = [self._load(p) for p in frame_paths]
        images = [img for img in images if img is not None]
        if len(images) < 2:
            return MotionDescriptor(dominant="unknown")

        magnitudes: list[float] = []
        angles: list[float] = []
        radialities: list[float] = []

        for a, b in zip(images, images[1:], strict=False):
            flow = cv2.calcOpticalFlowFarneback(
                a, b, None,
                pyr_scale=0.5,
                levels=3,
                winsize=15,
                iterations=3,
                poly_n=5,
                poly_sigma=1.2,
                flags=0,
            )
            mag, ang = cv2.cartToPolar(flow[..., 0], flow[..., 1])

            h, w = a.shape
            magnitudes.append(float(mag.mean()) / max(w, 1))
            angles.append(float(np.median(ang)))
            radialities.append(self._radiality(flow, w, h))

        mean_mag = float(np.mean(magnitudes))
        consistency = self._angular_consistency(angles)
        radiality = float(np.mean(radialities))

        dominant = self._classify(mean_mag, consistency, radiality, float(np.mean(angles)))

        return MotionDescriptor(
            dominant=dominant,
            magnitude=round(mean_mag, 5),
            confidence=round(self._confidence(mean_mag, consistency), 3),
            consistency=round(consistency, 3),
        )

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _load(self, path: Path) -> np.ndarray | None:
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            log.warning("could not read frame: %s", path)
            return None
        h, w = img.shape
        if w > self.target_width:
            scale = self.target_width / w
            img = cv2.resize(img, (self.target_width, max(1, int(h * scale))))
        # Light blur suppresses sensor noise that would otherwise dominate flow.
        return cv2.GaussianBlur(img, (5, 5), 0)

    @staticmethod
    def _radiality(flow: np.ndarray, w: int, h: int) -> float:
        """Measure how radial the flow field is.

        Computes the cosine similarity between each flow vector and the vector
        pointing outward from the frame centre. A field dominated by expansion or
        contraction scores near +/-1; a pure translation scores near 0.
        """
        ys, xs = np.mgrid[0:h, 0:w]
        cx, cy = w / 2.0, h / 2.0
        radial_x = xs - cx
        radial_y = ys - cy

        norm = np.sqrt(radial_x**2 + radial_y**2) + 1e-6
        u = flow[..., 0]
        v = flow[..., 1]
        flow_norm = np.sqrt(u**2 + v**2) + 1e-6

        cos = (u * radial_x + v * radial_y) / (flow_norm * norm)

        # Weight by flow magnitude so static edges do not dilute the estimate.
        weights = flow_norm / (flow_norm.max() + 1e-6)
        return float(np.sum(cos * weights) / (np.sum(weights) + 1e-6))

    @staticmethod
    def _angular_consistency(angles: list[float]) -> float:
        """How aligned the per-pair median flow directions are.

        Uses the circular mean resultant length: 1.0 means every frame pair moved
        in the same direction (a clean pan), near 0 means directions were random.
        """
        if not angles:
            return 0.0
        a = np.asarray(angles, dtype=np.float64)
        return float(np.sqrt(np.cos(a).mean() ** 2 + np.sin(a).mean() ** 2))

    def _classify(
        self,
        magnitude: float,
        consistency: float,
        radiality: float,
        mean_angle: float,
    ) -> str:
        if magnitude < self.static_threshold:
            return "static"

        if consistency < self.handheld_consistency:
            # Direction is unstable: either a shake or a moving subject in a
            # static frame. We report handheld, which is the more useful prior
            # for prompt generation.
            return "handheld"

        if radiality > self.radial_threshold:
            return "dolly_in"
        if radiality < -self.radial_threshold:
            return "dolly_out"

        # Convert the flow angle to a screen direction. Image y grows downward,
        # so a positive flow angle means moving down-right on screen.
        deg = np.degrees(mean_angle) % 360
        if deg < 45 or deg >= 315:
            return "pan_right"
        if 45 <= deg < 135:
            return "tilt_down"
        if 135 <= deg < 225:
            return "pan_left"
        return "tilt_up"

    @staticmethod
    def _confidence(magnitude: float, consistency: float) -> float:
        """Confidence in the classification.

        Deliberately conservative: a weak, incoherent flow field should produce a
        low score so the shot gets flagged for review instead of silently
        contributing a wrong camera value to the prompt.
        """
        mag_score = min(1.0, magnitude / 0.05)
        return max(0.0, min(1.0, 0.6 * consistency + 0.4 * mag_scale(mag_score)))


def mag_scale(x: float) -> float:
    return x


def analyse_motion(frame_paths: list[Path]) -> MotionDescriptor:
    """Convenience wrapper around `MotionAnalyzer`."""
    return MotionAnalyzer().analyse(frame_paths)
