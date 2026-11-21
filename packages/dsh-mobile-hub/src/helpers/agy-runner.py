#!/usr/bin/env python3
"""
Official Antigravity Python SDK runner for AllinOne Mobile Hub.
Reads JSON input from stdin:
  { "prompt": "...", "cwd": "...", "history": [{ "role": "user"|"assistant", "text": "..." }] }
Streams JSONL events to stdout:
  { "type": "thinking" | "tool_start" | "delta" | "done" | "error", ... }
"""
import asyncio
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as exc:
        emit({"type": "error", "message": f"Invalid JSON input: {exc}"})
        return

    try:
        from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
    except ImportError:
        emit({
            "type": "error",
            "message": (
                "本机尚未安装官方 Antigravity Python SDK（google-antigravity）。\n"
                "请在电脑终端执行：`pip install google-antigravity` 后即可远程发起并持续操控 Antigravity 会话。\n"
                "（注：浏览 Antigravity Desktop 的历史对话不受影响，随时可查。）"
            ),
        })
        return

    cwd = req.get("cwd") or os.getcwd()
    if os.path.isdir(cwd):
        os.chdir(cwd)

    history = req.get("history") or []
    prompt = req.get("prompt") or ""

    context_lines = []
    if history:
        context_lines.append("以下是该会话此前的历史上下文（用于接力继续对话）：")
        for turn in history[-12:]:
            role = "用户" if turn.get("role") == "user" else "助手"
            text = str(turn.get("text") or "").strip()[:1200]
            if text:
                context_lines.append(f"[{role}]: {text}")
        context_lines.append("--- 以上为历史上下文，下面是最新的用户指令 ---")

    full_prompt = ("\n".join(context_lines) + "\n\n" + prompt).strip() if context_lines else prompt

    config = LocalAgentConfig(
        system_instructions=f"你正在通过 AllinOne 移动远程控制中心执行任务，当前工作目录为：{cwd}。请清晰简洁地回复。",
        capabilities=CapabilitiesConfig(),
    )

    final_parts = []

    async with Agent(config) as agent:
        response = await agent.chat(full_prompt)

        async def pump_thoughts():
            thoughts = getattr(response, "thoughts", None)
            if thoughts is None:
                return
            try:
                async for thought in thoughts:
                    emit({"type": "thinking", "delta": str(thought)})
            except Exception:
                pass

        async def pump_tools():
            tool_calls = getattr(response, "tool_calls", None)
            if tool_calls is None:
                return
            try:
                async for call in tool_calls:
                    emit({
                        "type": "tool_start",
                        "tool": {
                            "id": str(getattr(call, "id", getattr(call, "name", "tool"))),
                            "name": str(getattr(call, "name", "tool")),
                            "input": getattr(call, "args", {}) or {},
                        },
                    })
            except Exception:
                pass

        async def pump_tokens():
            async for token in response:
                text = str(token)
                final_parts.append(text)
                emit({"type": "delta", "delta": text})

        await asyncio.gather(pump_thoughts(), pump_tools(), pump_tokens())

    emit({"type": "done", "finalText": "".join(final_parts)})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        sys.exit(1)
