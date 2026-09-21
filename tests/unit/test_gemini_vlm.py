"""Tests for the Gemini vision provider and its registry wiring.

Three things are pinned here, each because it is easy to get wrong and invisible
from reading the happy path:

1. The request *shape*. Gemini is not OpenAI-compatible -- images go in
   `inline_data` parts, the key travels in `x-goog-api-key`, and the endpoint is
   `/v1beta/models/{model}:generateContent`. A silent regression to OpenAI's
   shape would still compile and only fail against the real API.
2. The error *semantics*. A safety block returns HTTP 200 with no candidate
   parts at all, so reporting it as "no content" sends you hunting a parsing bug
   instead of a content filter. 429/5xx must be retryable, other 4xx must not.
3. The registry *contract*. Unknown provider names must list what is actually
   available, and a missing key must name both the variable and the slot.

No network access: `httpx.AsyncClient` is replaced with a stub that records the
request and returns a canned response.
"""

from __future__ import annotations

import base64
import json

import pytest

from vrh.contracts.segment import ShotContext
from vrh.providers.base import RetryableError
from vrh.providers.gemini_vlm import (
    DEFAULT_BASE_URL,
    GeminiVisionProvider,
    _first_text,
)


def make_context() -> ShotContext:
    return ShotContext(
        shot_id=2,
        start_s=1.0,
        end_s=2.0,
        duration_s=1.0,
        total_shots=5,
        motion_hint="static",
    )


def annotation_body(**overrides) -> dict:
    """A minimal well-formed Gemini response wrapping one annotation.

    The inner field names must match what `_to_annotation` reads -- `visual_style`
    rather than `style`, `camera` as a nested object, and so on. Getting these
    wrong does not raise; it silently yields default-valued fields, which is why
    `TestAnnotationContract` compares against the OpenAI path field by field.
    """
    payload = {
        "subject": "a red cube on a table",
        "subject_count": 1,
        "action": {"label": "sitting still", "phase": "mid", "confidence": 0.8},
        "scene": "indoor studio",
        "environment": "indoor",
        "time_of_day": "day",
        "weather": "",
        "camera": {
            "shot_size": "medium",
            "angle": "eye_level",
            "motion": "static",
            "speed": "static",
        },
        "lighting": "soft key light",
        "color_palette": ["red", "grey"],
        "composition": "centred",
        "visual_style": "photorealistic",
        "on_screen_text": [],
        "confidence": 0.9,
    }
    payload.update(overrides)
    return {
        "candidates": [
            {
                "content": {"parts": [{"text": json.dumps(payload)}]},
                "finishReason": "STOP",
            }
        ]
    }


class _StubResponse:
    def __init__(self, status_code: int, body: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text or json.dumps(self._body)

    def json(self) -> dict:
        return self._body


class _StubClient:
    """Stands in for `httpx.AsyncClient`, capturing the outgoing request."""

    last_request: dict | None = None

    def __init__(self, response: _StubResponse | Exception):
        self._response = response

    async def __aenter__(self) -> "_StubClient":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False

    async def post(self, url, headers=None, json=None):  # noqa: A002
        type(self).last_request = {"url": url, "headers": headers, "json": json}
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


@pytest.fixture
def stub_http(monkeypatch):
    """Install a stub httpx client; returns a setter for the canned response."""

    def install(response):
        import vrh.providers.gemini_vlm as module

        _StubClient.last_request = None
        monkeypatch.setattr(
            module.httpx, "AsyncClient", lambda **kwargs: _StubClient(response)
        )
        return _StubClient

    return install


class TestRequestShape:
    """The request must be Gemini-shaped, not OpenAI-shaped."""

    async def test_endpoint_is_per_model_generate_content(self, stub_http):
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="gemini-2.5-flash", api_key="k")

        await provider.annotate([b"\xff\xd8\xff"], make_context())

        url = client.last_request["url"]
        assert url == (
            f"{DEFAULT_BASE_URL}/v1beta/models/gemini-2.5-flash:generateContent"
        )

    async def test_key_travels_in_x_goog_api_key_header(self, stub_http):
        """Not `Authorization: Bearer` -- that is the OpenAI convention."""
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="secret-key")

        await provider.annotate([b"\xff\xd8\xff"], make_context())

        headers = client.last_request["headers"]
        assert headers["x-goog-api-key"] == "secret-key"
        assert "Authorization" not in headers

    async def test_frames_use_inline_data_not_image_url(self, stub_http):
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        await provider.annotate([b"\x01\x02", b"\x03\x04"], make_context())

        parts = client.last_request["json"]["contents"][0]["parts"]
        media = [p for p in parts if "inline_data" in p]
        assert len(media) == 2, "one inline_data part per frame"
        assert all(p["inline_data"]["mime_type"] == "image/jpeg" for p in media)
        assert media[0]["inline_data"]["data"] == base64.b64encode(b"\x01\x02").decode(
            "ascii"
        )
        assert not any("image_url" in p for p in parts), "OpenAI shape leaked in"

    async def test_text_part_precedes_media_so_it_reads_as_instruction(
        self, stub_http
    ):
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        await provider.annotate([b"\x01"], make_context())

        parts = client.last_request["json"]["contents"][0]["parts"]
        assert "text" in parts[0], "instruction must come first"
        assert "inline_data" in parts[1]

    async def test_json_mode_requested_via_generation_config(self, stub_http):
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        await provider.annotate([b"\x01"], make_context())

        config = client.last_request["json"]["generationConfig"]
        assert config["responseMimeType"] == "application/json"

    async def test_trailing_slash_on_base_url_does_not_double_up(self, stub_http):
        """`.../` would otherwise produce `//v1beta`, which the API rejects."""
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(
            model="m", api_key="k", base_url="https://example.com/"
        )

        await provider.annotate([b"\x01"], make_context())

        assert client.last_request["url"] == (
            "https://example.com/v1beta/models/m:generateContent"
        )
        assert "//v1beta" not in client.last_request["url"]

    async def test_empty_frames_is_rejected_before_any_request(self, stub_http):
        client = stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        with pytest.raises(ValueError, match="no frames"):
            await provider.annotate([], make_context())

        assert client.last_request is None, "must not call the API with no evidence"


class TestErrorSemantics:
    """Which failures retry, and which produce which message."""

    async def test_transport_error_is_retryable(self, stub_http):
        import httpx

        stub_http(httpx.ConnectError("connection refused"))
        provider = GeminiVisionProvider(model="m", api_key="k")

        with pytest.raises(RetryableError, match="transport failure"):
            await provider.annotate([b"\x01"], make_context())

    async def test_rate_limit_is_retryable(self, stub_http):
        stub_http(_StubResponse(429, text="quota exceeded"))
        provider = GeminiVisionProvider(model="m", api_key="k")

        with pytest.raises(RetryableError):
            await provider.annotate([b"\x01"], make_context())

    async def test_server_error_is_retryable(self, stub_http):
        stub_http(_StubResponse(503, text="unavailable"))
        provider = GeminiVisionProvider(model="m", api_key="k")

        with pytest.raises(RetryableError):
            await provider.annotate([b"\x01"], make_context())

    async def test_bad_request_is_not_retryable(self, stub_http):
        """Retrying a malformed request just burns quota."""
        stub_http(_StubResponse(400, text="invalid argument"))
        provider = GeminiVisionProvider(model="m", api_key="k")

        with pytest.raises(RuntimeError) as excinfo:
            await provider.annotate([b"\x01"], make_context())

        assert not isinstance(excinfo.value, RetryableError)
        assert "400" in str(excinfo.value)


class TestFirstText:
    """Response-body edge cases that need distinct, actionable messages."""

    def test_extracts_and_joins_text_parts(self):
        body = {"candidates": [{"content": {"parts": [{"text": "a"}, {"text": "b"}]}}]}
        assert _first_text(body) == "ab"

    def test_safety_block_names_the_reason(self):
        """A safety block is HTTP 200 with no candidates -- easy to misread."""
        with pytest.raises(RuntimeError) as excinfo:
            _first_text({"promptFeedback": {"blockReason": "SAFETY"}})

        message = str(excinfo.value)
        assert "blockReason" in message
        assert "SAFETY" in message
        assert "no candidates" not in message, "must not be confused with an empty body"

    def test_missing_candidates_without_reason_says_so(self):
        with pytest.raises(RuntimeError, match="no candidates"):
            _first_text({})

    def test_empty_parts_names_the_finish_reason(self):
        """Truncation is a different fix from a content filter."""
        body = {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]}

        with pytest.raises(RuntimeError) as excinfo:
            _first_text(body)

        assert "MAX_TOKENS" in str(excinfo.value)
        assert "empty candidate" in str(excinfo.value)

    def test_unknown_finish_reason_still_reported(self):
        body = {"candidates": [{"content": {"parts": [{"text": "  "}]}}]}
        with pytest.raises(RuntimeError, match="unspecified"):
            _first_text(body)


class TestAnnotationContract:
    """Both providers must produce indistinguishable annotations."""

    async def test_provider_is_labelled_gemini_vlm(self, stub_http):
        stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        annotation = await provider.annotate([b"\x01"], make_context())

        assert annotation.provider == "gemini_vlm"
        assert annotation.shot_id == 2

    async def test_field_mapping_matches_the_openai_path(self, stub_http):
        """Same annotation payload -> same ShotAnnotation either way.

        Both providers must be interchangeable, otherwise an A/B comparison
        between them measures the mapping difference rather than the model.
        """
        from vrh.providers.openai_vlm import OpenAIVisionProvider

        stub_http(_StubResponse(200, annotation_body()))
        provider = GeminiVisionProvider(model="m", api_key="k")

        gemini = await provider.annotate([b"\x01"], make_context())

        # The OpenAI path takes the bare annotation dict, not the response
        # envelope -- unwrap the Gemini envelope so the inputs are identical.
        inner = json.loads(
            annotation_body()["candidates"][0]["content"]["parts"][0]["text"]
        )
        openai = OpenAIVisionProvider._to_annotation(inner, make_context())

        # `provider` is the only intended difference; everything else must match.
        assert gemini.model_dump(exclude={"provider"}) == openai.model_dump(
            exclude={"provider"}
        )

    async def test_name_identifies_backend_and_model(self):
        provider = GeminiVisionProvider(model="gemini-2.5-flash", api_key="k")
        assert provider.name == "gemini:gemini-2.5-flash"


class TestRegistryWiring:
    """The registry must accept `gemini_vlm` and reject unknown names clearly."""

    def test_gemini_is_selectable_and_needs_a_key(self, monkeypatch):
        from vrh.config import load_settings
        from vrh.providers.registry import build_providers

        monkeypatch.setenv("VRH_PROVIDERS__VISION__NAME", "gemini_vlm")
        monkeypatch.setenv("VRH_PROVIDERS__VISION__MODEL", "gemini-2.5-flash")
        monkeypatch.setenv("VRH_PROVIDERS__VISION__API_KEY_ENV", "VRH_TEST_GEMINI_KEY")
        monkeypatch.setenv("VRH_TEST_GEMINI_KEY", "test-key")

        providers = build_providers(load_settings())

        assert isinstance(providers.vision, GeminiVisionProvider)
        assert providers.vision.name == "gemini:gemini-2.5-flash"

    def test_missing_key_names_both_the_variable_and_the_slot(self, monkeypatch):
        from vrh.config import load_settings
        from vrh.providers.registry import build_providers

        monkeypatch.delenv("VRH_TEST_ABSENT_KEY", raising=False)
        monkeypatch.setenv("VRH_PROVIDERS__VISION__NAME", "gemini_vlm")
        monkeypatch.setenv("VRH_PROVIDERS__VISION__API_KEY_ENV", "VRH_TEST_ABSENT_KEY")

        with pytest.raises(Exception) as excinfo:
            build_providers(load_settings())

        message = str(excinfo.value)
        assert "VRH_TEST_ABSENT_KEY" in message, "must name the env var to set"
        assert "gemini_vlm" in message
        assert "vision" in message

    def test_unknown_name_lists_what_is_actually_available(self, monkeypatch):
        """The message is the only discovery path for a mistyped provider."""
        from vrh.config import load_settings
        from vrh.providers.registry import build_providers

        monkeypatch.setenv("VRH_PROVIDERS__VISION__NAME", "claude")

        with pytest.raises(Exception) as excinfo:
            build_providers(load_settings())

        message = str(excinfo.value)
        assert "claude" in message
        for available in ("fake", "openai_vlm", "gemini_vlm"):
            assert available in message, f"'{available}' must be listed"
