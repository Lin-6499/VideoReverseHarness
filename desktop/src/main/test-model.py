"""模型连通性自检（供桌面端的「测试连接」按钮调用）。

设计要点 —— 为什么是「复用 harness 自己的 provider」而不是在这里另写 HTTP：

如果这里手搓一份请求，它和 harness 真实调用之间就会漂移 —— 测通了但实际
跑不通，是最难查的一类问题。所以这里只做三件事：
  1. 构造一个 1x1 的 JPEG
  2. 从环境变量读出配置（与真实运行完全相同的注入方式）
  3. 走 registry 拿到 provider，调一次 annotate()

成功时在 stdout 打印一行人类可读的结论；失败时把异常写到 stderr 并以
非零码退出。桌面端据此区分成功与失败。

刻意**不**打印 Key 或任何请求头。
"""

from __future__ import annotations

import asyncio
import base64
import sys

# 一张 1x1 的白色 JPEG。内联是为了不依赖外部文件 —— 自检脚本必须能在任何
# 工作目录下跑起来（打包后 cwd 与开发态不同）。
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpJ/9k="
)


async def main() -> int:
    try:
        from vrh.config import load_settings
        from vrh.contracts.segment import ShotContext
        from vrh.providers.registry import build_providers
    except ImportError as exc:
        print(f"无法导入 harness 模块：{exc}", file=sys.stderr)
        return 2

    try:
        settings = load_settings()
        providers = build_providers(settings)
    except Exception as exc:  # noqa: BLE001 - 配置错误要原样呈现给用户
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    vision = providers.vision
    if getattr(vision, "name", "?") == "fake":
        # 理论上桌面端已拦下这种情况，这里再兜一层，避免「测通了但其实没测」。
        print("当前是离线占位，未发起真实请求", file=sys.stderr)
        return 2

    frame = base64.b64decode(TINY_JPEG_B64)
    # 字段必须与 ShotContext 的必填项完全一致 —— 它是 pydantic 模型，
    # 少一个就会在调用 provider 之前抛 ValidationError，看起来像模型的问题。
    context = ShotContext(
        shot_id=1,
        start_s=0.0,
        end_s=1.0,
        duration_s=1.0,
        total_shots=1,
        motion_hint="static",
    )

    try:
        annotation = await vision.annotate([frame], context)
    except Exception as exc:  # noqa: BLE001 - 直接把 provider 的报错交给用户
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    # 只说「通了」并附一点可核对的证据 —— 不打印模型返回的完整内容，
    # 那对「连接是否可用」这个判断没有增量信息。
    subject = (annotation.subject or "").strip() or "(空)"
    print(f"{vision.name} 返回正常，subject={subject[:40]}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
