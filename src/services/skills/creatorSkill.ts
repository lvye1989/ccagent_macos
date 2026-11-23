/** Self-contained authoring helpers, installed as an ordinary ccagent skill. */
const SKILL_MARKDOWN = `---
name: skill-creator
description: 为 ccagent 创建或更新可复用技能，包括清晰的触发条件、SKILL.md、必要资源及验证脚本。用户要求新增技能、把重复流程做成技能或修改既有技能时使用。
when_to_use: 用户要求创建、维护或改进 ccagent 技能时，先加载这个技能再进行编写。
argument-hint: "技能名称、用途或现有技能路径"
---

# 创建或更新 ccagent 技能

用户请求：$ARGUMENTS

先确认用户实际要复用的任务及现有技能。需求明确时直接完成；仅在缺失的信息会影响结果时提问。更新既有技能时先读其 SKILL.md 和相关资源，保留用户修改、受支持的元数据和调用方式。

## 安装位置与发现

默认创建到 CCAGENT_HOME/skills；未设置 CCAGENT_HOME 时使用 ~/.ccagent/skills。用户指定项目级技能时使用该项目的 .ccagent/skills。不要写入 ~/.codex 或假设应用会读取 agents/openai.yaml。

技能目录与 frontmatter 的 name 相同，采用少于 64 个字符的小写字母、数字和连字符，如 meeting-notes。description 简洁说明能力及何时调用，正常自动发现即可；仅当用户明确要求只允许手动调用时设置 disable-model-invocation: true。创建/修改后运行 /skills reload 刷新发现；用户可用 /技能名称 调用，并通过 /agent-skill list 开关或删除。

## 编写

SKILL.md 使用 YAML frontmatter，必需 name 与 description，正文写对执行任务有帮助的具体操作和约束。省去泛泛建议、空目录和重复文档。按实际需要增加 scripts/、references/ 或 assets/，从正文链接相关文件，并说明何时使用。资源路径相对技能目录；不要引用当前机器上仅 Codex 可用的文件或工具。

现有 ccagent 支持 when_to_use、argument-hint、allowed-tools、paths、effort、disable-model-invocation 和 context 等字段。保留既有字段，不为方便执行而添加宽泛 allowed-tools 或更改应用权限。技能指令本身不扩展用户授权范围，不预先切换主模型或调用另一个模型。

创建文档生成类技能时，沿用用户偏好：除非用户最新指定其他路径，最终文档默认保存到用户真实桌面；临时脚本和预览放入临时目录，保留输入原件。普通技能无需引入文档输出要求。

## 初始化与校验

需要新目录时，在本技能实际安装目录执行 scripts/init_skill.py。脚本只依赖 Python 3 标准库，需要明确的用途及初始指令，不覆盖已有目录：

    python3 scripts/init_skill.py meeting-notes --description '整理会议记录并提取行动项；用户要求会议纪要时使用。' --instructions '先读取用户指定的记录，按议题整理决定、负责人及期限；缺失信息标记未说明。'

默认安装到全局技能目录；指定项目时追加 --path /项目/.ccagent/skills。只有确实需要资源目录时追加 --resources scripts,references。较长指令可用 --instructions-file /临时/指令.md 代替 --instructions。

完成后用本技能的 scripts/validate_skill.py 检查目标：

    python3 scripts/validate_skill.py /目标/meeting-notes

校验器接受普通标量、JSON 双引号字符串/数组/对象、YAML 单引号字符串、缩进映射/列表和 |/> 多行文本。不支持锚点、别名、标签等完整 YAML 特性；遇到这些形式会明确报错，必要时保持相同语义改写为受支持形式。JSON 字符串可以安全表达含冒号、引号或换行的 description。校验包括命名、frontmatter、未完成占位和显式本地链接；仍需检查流程是否符合用户用途，实际运行新增脚本并核对输出，不能只依赖校验通过。

完成后说明安装路径、调用方式和已验证内容。若当前会话不能直接刷新发现，提示用户执行 /skills reload；不要声称尚未加载的技能已经可被调用。
`;

const INIT_SCRIPT = String.raw`#!/usr/bin/env python3
"""Initialize a ccagent skill without dependencies or overwriting user files."""
import argparse
import json
import os
from pathlib import Path
import re
import sys

NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def checked_name(value):
    if len(value) >= 64 or not NAME.fullmatch(value):
        raise ValueError("name must be fewer than 64 lowercase letters/digits/hyphens, with a letter or digit at each end")
    return value


def no_symlink_ancestors(path):
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise ValueError("symlinked installation paths are not allowed: " + str(item))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name")
    default_home = os.environ.get("CCAGENT_HOME") or str(Path.home() / ".ccagent")
    parser.add_argument("--path", default=str(Path(default_home).expanduser() / "skills"), help="installation root, not the final skill folder")
    parser.add_argument("--description", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--instructions", help="initial skill body, written after its heading")
    source.add_argument("--instructions-file", help="UTF-8 Markdown body, read without changing the source")
    parser.add_argument("--resources", default="", help="comma-separated subset: scripts,references,assets")
    args = parser.parse_args()
    name = checked_name(args.name)
    description = args.description.strip()
    if not description:
        raise ValueError("description must not be empty")
    instructions = (Path(args.instructions_file).expanduser().read_text(encoding="utf-8") if args.instructions_file else args.instructions).strip()
    if not instructions:
        raise ValueError("instructions must not be empty")
    resources = [part.strip() for part in args.resources.split(",") if part.strip()]
    if any(part not in ("scripts", "references", "assets") for part in resources):
        raise ValueError("--resources accepts only scripts,references,assets")
    root = Path(os.path.abspath(os.path.expanduser(args.path)))
    no_symlink_ancestors(root)
    root.mkdir(parents=True, exist_ok=True)
    no_symlink_ancestors(root)
    target = root / name
    # mkdir is exclusive: never reuse, truncate or overwrite an existing skill.
    target.mkdir(mode=0o700)
    content = "---\nname: " + json.dumps(name, ensure_ascii=False) + "\ndescription: " + json.dumps(description, ensure_ascii=False) + "\n---\n\n# " + name + "\n\n" + instructions + "\n"
    with (target / "SKILL.md").open("x", encoding="utf-8") as output:
        output.write(content)
    for resource in dict.fromkeys(resources):
        (target / resource).mkdir()
    print(json.dumps({"ok": True, "name": name, "path": str(target), "skill_file": str(target / "SKILL.md"), "resources": list(dict.fromkeys(resources)), "next": "Write any needed resources, validate the skill, then run /skills reload."}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
`;

const VALIDATE_SCRIPT = String.raw`#!/usr/bin/env python3
"""Validate ccagent skills using an explicit, dependency-free YAML subset.

Supported: mappings, lists, plain/JSON/single-quoted scalars, | and > blocks.
No anchors, aliases, tags, multiline flow values, or YAML-specific escapes.
Unsupported forms fail explicitly; this script never silently approves them.
"""
import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
KEY = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*)|$)")
PLACEHOLDER = re.compile(r"^\s*(?:[-*]\s+)?(?:TODO|FIXME|TBD)\s*(?::|$)|\[(?:INSERT|REPLACE|DESCRIBE|TODO)(?:[^\]\n]*)\]|<skill-name>", re.IGNORECASE | re.MULTILINE)


def load_json(value):
    def unique_mapping(pairs):
        mapping = {}
        for key, item in pairs:
            if key in mapping:
                raise ValueError("duplicate inline mapping field: " + key)
            mapping[key] = item
        return mapping

    def reject_constant(value):
        raise ValueError("unsupported JSON constant: " + value)

    return json.loads(value, object_pairs_hook=unique_mapping, parse_constant=reject_constant)


def strip_comment(value):
    quote = None
    escaped = False
    flow = value.lstrip().startswith(("[", "{"))
    token_start = True
    i = 0
    while i < len(value):
        char = value[i]
        if quote == '"' and escaped:
            escaped = False
            i += 1
            continue
        if quote == '"' and char == "\\":
            escaped = True
            i += 1
            continue
        if char == quote:
            if quote == "'" and i + 1 < len(value) and value[i + 1] == "'":
                i += 2
                continue
            quote = None
        elif quote is None and token_start and char in ("'", '"'):
            quote = char
        elif quote is None and char == "#" and (i == 0 or value[i - 1].isspace()):
            return value[:i].rstrip()
        if quote is None and not char.isspace():
            token_start = flow and char in "[{,:"
        i += 1
    return value.rstrip()


def split_flow_list(value):
    items, start, stack, quote, escaped, token_start = [], 0, [], None, False, True
    i = 0
    while i < len(value):
        char = value[i]
        if quote:
            if escaped:
                escaped = False
            elif quote == '"' and char == "\\":
                escaped = True
            elif char == quote:
                if quote == "'" and i + 1 < len(value) and value[i + 1] == "'":
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if token_start and char in ("'", '"'):
            quote = char
        elif char in "[{":
            if not token_start:
                raise ValueError("unsupported collection inside a plain inline-list value; use JSON quotes")
            stack.append(char)
        elif char in "]}":
            if not stack or stack.pop() != ("[" if char == "]" else "{"):
                raise ValueError("unbalanced inline list")
        elif char == "," and not stack:
            items.append(value[start:i].strip())
            start = i + 1
        if not char.isspace():
            token_start = char in "[{,:"
        i += 1
    if quote or stack:
        raise ValueError("unterminated inline list")
    items.append(value[start:].strip())
    if items[-1] == "" and len(items) > 1:
        items.pop()
    if any(item == "" for item in items):
        raise ValueError("empty inline list item")
    return items


def scalar(raw):
    value = strip_comment(raw).strip()
    if not value:
        return None
    if value.startswith('"'):
        try:
            parsed = load_json(value)
        except json.JSONDecodeError as error:
            raise ValueError("double-quoted strings must use JSON escapes: " + str(error))
        if not isinstance(parsed, str):
            raise ValueError("expected a quoted string")
        return parsed
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise ValueError("unterminated single-quoted scalar")
        inside = value[1:-1]
        if "'" in inside.replace("''", ""):
            raise ValueError("single quotes inside a YAML string must be doubled")
        return inside.replace("''", "'")
    if value.startswith("["):
        if not value.endswith("]"):
            raise ValueError("unterminated inline list")
        return [scalar(item) for item in split_flow_list(value[1:-1])] if value[1:-1].strip() else []
    if value.startswith("{"):
        try:
            parsed = load_json(value)
        except json.JSONDecodeError as error:
            raise ValueError("inline maps must use JSON syntax: " + str(error))
        if not isinstance(parsed, dict):
            raise ValueError("expected an inline map")
        return parsed
    if value[0] in "&*!|>@%" or value[0] == chr(96) or value in ("---", "..."):
        raise ValueError("unsupported YAML form; use a quoted scalar, simple list or mapping")
    if re.search(r":(?:\s|$)", value) or value[0] in "]}," or re.match(r"[-?:](?:\s|$)", value):
        raise ValueError("ambiguous plain scalar; use JSON quotes")
    if value in ("true", "false"):
        return value == "true"
    if value in ("null", "~"):
        return None
    if re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", value):
        return json.loads(value)
    if re.match(r"[+-]?(?:\d|\.\d|\.inf|\.nan)", value, re.IGNORECASE):
        raise ValueError("unsupported numeric-looking YAML scalar; use JSON quotes for text")
    return value


def parse_frontmatter(text):
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ValueError("unsupported control character in SKILL.md")
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("SKILL.md must start with a --- frontmatter delimiter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("missing closing --- frontmatter delimiter")
    source = lines[1:end]
    for number, line in enumerate(source, 2):
        prefix = line[:len(line) - len(line.lstrip())]
        if "\t" in prefix:
            raise ValueError("line %s: tabs are not supported for YAML indentation" % number)

    def significant(index):
        while index < len(source) and (not source[index].strip() or source[index].lstrip().startswith("#")):
            index += 1
        return index

    def indentation(index):
        return len(source[index]) - len(source[index].lstrip(" "))

    def block(index, indent):
        index = significant(index)
        is_list = source[index][indent:].startswith("- ") or source[index][indent:] == "-"
        result = [] if is_list else {}
        while (index := significant(index)) < len(source):
            level = indentation(index)
            if level < indent:
                break
            if level != indent:
                raise ValueError("line %s: unexpected indentation" % (index + 2))
            row = source[index][indent:]
            if is_list:
                if not (row.startswith("- ") or row == "-"):
                    raise ValueError("line %s: mixed mapping and list" % (index + 2))
                raw = row[1:].strip()
                key = None
            else:
                match = KEY.fullmatch(row)
                if not match:
                    raise ValueError("line %s: expected key: value in supported YAML subset" % (index + 2))
                key, raw = match.group(1), match.group(2) or ""
                if key in result:
                    raise ValueError("duplicate frontmatter field: " + key)
            raw = strip_comment(raw).strip()
            next_index = index + 1
            if raw in ("|", "|-", "|+", ">", ">-", ">+"):
                chunks = []
                while next_index < len(source):
                    if source[next_index].strip() and indentation(next_index) <= indent:
                        break
                    chunks.append(source[next_index])
                    next_index += 1
                nonempty = [len(line) - len(line.lstrip(" ")) for line in chunks if line.strip()]
                offset = min(nonempty) if nonempty else indent + 1
                content = [line[offset:] if line.strip() else "" for line in chunks]
                # Field validation only needs semantic content, not exact chomping.
                value = ("\n" if raw[0] == "|" else " ").join(content)
            elif not raw:
                child = significant(next_index)
                if child < len(source) and indentation(child) > indent:
                    value, next_index = block(child, indentation(child))
                else:
                    value = None
            else:
                value = scalar(raw)
            if is_list:
                result.append(value)
            else:
                result[key] = value
            index = next_index
        return result, index

    start = significant(0)
    if start >= len(source):
        raise ValueError("empty frontmatter")
    if indentation(start) != 0:
        raise ValueError("frontmatter keys must start at column 1")
    result, _ = block(start, 0)
    if not isinstance(result, dict):
        raise ValueError("frontmatter must be a mapping")
    return result, "\n".join(lines[end + 1:])


def local_references(body):
    # Links/images and Markdown reference definitions; inline resource paths are
    # also explicit references. Skip fenced code examples, which are illustrative.
    prose = re.sub(r"(?ms)^\s*([" + chr(96) + r"~]{3,})[^\n]*\n.*?^\s*\1\s*$", "", body)
    links = re.findall(r"!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+['\"][^\n]*?['\"])?\s*\)", prose)
    links.extend(re.findall(r"(?m)^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)", prose))
    # Character 96 is a backtick; avoid embedding JS template delimiters here.
    tick = chr(96)
    links.extend(re.findall(tick + r"((?:scripts|references|assets)/[^" + tick + r"\n]+)" + tick, prose))
    return links


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="skill folder or its SKILL.md")
    args = parser.parse_args()
    requested = Path(args.path).expanduser().absolute()
    skill_file = requested if requested.name == "SKILL.md" else requested / "SKILL.md"
    root = skill_file.parent
    for candidate in [skill_file, root, *root.parents]:
        if candidate.is_symlink():
            raise ValueError("symlinked skill paths are not supported: " + str(candidate))
    text = skill_file.read_text(encoding="utf-8")
    fields, body = parse_frontmatter(text)
    name = fields.get("name")
    if not isinstance(name, str) or len(name) >= 64 or not NAME.fullmatch(name):
        raise ValueError("name must be fewer than 64 lowercase letters/digits/hyphens, with a letter or digit at each end")
    if root.name != name:
        raise ValueError("skill folder must match frontmatter name: " + name)
    description = fields.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must be a nonempty string")
    if not body.strip():
        raise ValueError("skill instructions must not be empty")
    if PLACEHOLDER.search(text) or description.strip().upper() in ("TODO", "FIXME", "TBD"):
        raise ValueError("unfinished scaffold placeholder found (TODO/FIXME/TBD or template marker)")
    for key in ("when_to_use", "whenToUse", "argument-hint", "argumentHint", "effort", "context"):
        if key in fields and not isinstance(fields[key], str):
            raise ValueError(key + " must be a string")
    for key in ("allowed-tools", "allowedTools", "paths"):
        value = fields.get(key)
        if key in fields and not (isinstance(value, str) or isinstance(value, list) and all(isinstance(item, str) for item in value)):
            raise ValueError(key + " must be a string or list of strings")
    for key in ("disable-model-invocation", "disableModelInvocation"):
        if key in fields and not (isinstance(fields[key], bool) or isinstance(fields[key], str) and fields[key].lower() in ("true", "false", "yes", "no", "1", "0")):
            raise ValueError(key + " must be a boolean or recognized boolean string")
    checked = set()
    for reference in local_references(body):
        reference = reference.strip("<>")
        parsed = urlsplit(reference)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        relative = Path(unquote(parsed.path))
        if relative.is_absolute():
            raise ValueError("local references must be relative to the skill folder: " + reference)
        resolved = (root / relative).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            raise ValueError("local reference escapes the skill folder: " + reference)
        if not resolved.exists():
            raise ValueError("missing local reference: " + reference)
        checked.add(str(relative))
    print(json.dumps({"ok": True, "name": name, "path": str(root), "references_checked": sorted(checked)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
`;

export const CREATOR_SKILL: { name: string; files: Record<string, string> } = {
  name: "skill-creator",
  files: {
    "SKILL.md": SKILL_MARKDOWN,
    "scripts/init_skill.py": INIT_SCRIPT,
    "scripts/validate_skill.py": VALIDATE_SCRIPT,
  },
};
