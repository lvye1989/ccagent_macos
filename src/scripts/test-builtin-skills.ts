/** Installed skill discovery, authoring helpers and Office package inspection. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { BUILTIN_SKILLS, ensureBuiltinSkills } from "../services/skills/builtins.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { clearSkills, findSkill, getInstalledSkills, getModelVisibleSkills } from "../services/skills/registry.js";
import { splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import { formatSkillsSystemReminder } from "../services/skills/budget.js";
import { bootstrapAgentSkills, setSkillState } from "../utils/agentSkillsEnabled.js";
import { skillTool } from "../tools/skillTool.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { toolResultText } from "../tools/Tool.js";
import { QueryEngine } from "../core/queryEngine.js";
import { loginForTest } from "./helpers/accountFixture.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-builtin-skills-")));
const previousEnv = { ...process.env }, previousFetch = globalThis.fetch;
const account = await loginForTest(path.join(root, "home"));
const home = account.home, skillsDir = path.join(home, "skills");
const names = ["skill-creator", "word-skill", "ppt-skill", "excel-skill"];
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log(`  [PASS] ${label}`); }
function runPython(args: string[], success = true) {
  const result = spawnSync(process.env.CCAGENT_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3"), args, {
    env: process.env, cwd: root, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, success ? 0 : 1, result.stderr || result.stdout || result.error?.message);
  return JSON.parse((result.stdout || result.stderr).trim());
}
async function localCommand(text: string) {
  const output: string[] = [];
  for await (const event of new QueryEngine({ model: "fixture", toolContext: { cwd: root } }).submitMessage(text)) {
    assert.equal(event.type, "command");
    if (event.type === "command") { assert.notEqual(event.kind, "error", event.message); output.push(event.message); }
  }
  return output.join("\n");
}
try {
  process.env.CCAGENT_HOME = home;
  process.env.CCAGENT_DISABLE_HOOKS = "1";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(account.origin + "/")) return previousFetch(url, init);
    throw new Error("Local built-in skill checks must not call a provider");
  };
  await bootstrapAgentSkills();
  assert.deepEqual(await ensureBuiltinSkills(), []);
  await bootstrapSkills(root);
  check(names.every((name) => findSkill(name)?.source === "user") && getInstalledSkills().length === BUILTIN_SKILLS.length,
    "All four skills install globally alongside the audio skill and appear in the registry");
  for (const definition of BUILTIN_SKILLS) {
    const file = path.join(skillsDir, definition.name, "SKILL.md");
    const parsed = splitFrontmatter(await fs.readFile(file, "utf8"));
    assert.equal(parsed.parseError, undefined); assert.equal(parsed.raw.name, definition.name);
    assert.match(definition.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const relative of Object.keys(definition.files)) assert.ok((await fs.stat(path.join(skillsDir, definition.name, relative))).isFile());
  }
  check(true, "Every packaged skill has a valid matching name and installs all referenced resources");
  for (const name of names) {
    let grants = 0;
    const result = await skillTool.call({ skill: name, args: "fixture request" }, { cwd: root, addSessionAllowRules: () => { grants++; } });
    assert.ok(!result.isError); assert.ok(toolResultText(result.content).includes("fixture request")); assert.equal(grants, 0);
    const expanded = (new QueryEngine({ model: "fixture", toolContext: { cwd: root } }) as unknown as {
      tryExpandSkillCommand(input: string): { bodyText: string } | null;
    }).tryExpandSkillCommand(`/${name} fixture request`);
    assert.ok(expanded);
    assert.ok(expanded.bodyText.includes("fixture request"));
    assert.ok(!expanded.bodyText.includes("${CLAUDE_SKILL_DIR}"));
  }
  check(true, "Each skill loads through Skill and its slash command without automatically granting broad tool permissions");
  check(names.every((name) => (formatSkillsSystemReminder(getModelVisibleSkills())).includes(name)), "Enabled skills are discoverable for ordinary language requests");
  check(formatSkillsSystemReminder(getModelVisibleSkills()).includes("invoke skill-creator before writing"), "Creating reusable skills is directed through the available skill-creator workflow");
  const read = await fileReadTool.call({ file_path: path.join(skillsDir, "word-skill", "references", "word-editing.md") }, { cwd: root });
  check(!read.isError && toolResultText(read.content).includes("python-docx"), "Installed global references are readable from a different working directory");
  check(names.every((name) => (getInstalledSkills().find((s) => s.name === name))) && (await localCommand("/agent-skill list")).includes("excel-skill · Open"), "The local management list includes the new skills and current states");

  const creatorDir = path.join(skillsDir, "skill-creator");
  const init = path.join(creatorDir, "scripts", "init_skill.py"), validate = path.join(creatorDir, "scripts", "validate_skill.py");
  for (const name of names) assert.equal(runPython([validate, path.join(skillsDir, name)]).ok, true);
  check(true, "The installed authoring validator accepts all four shipped skills and their local references");
  const created = runPython([init, "meeting-notes", "--description", "Create meeting notes", "--instructions", "Read the supplied notes and extract decisions and action owners."]);
  assert.equal(created.path, path.join(skillsDir, "meeting-notes")); assert.equal(runPython([validate, created.path]).ok, true);
  check(true, "The installed initializer creates a valid global skill with no extra Python packages");
  const before = await fs.readFile(path.join(created.path, "SKILL.md"), "utf8");
  assert.equal(runPython([init, "meeting-notes", "--description", "changed", "--instructions", "changed"], false).ok, false);
  assert.equal(runPython([init, "bad.name", "--description", "bad", "--instructions", "bad"], false).ok, false);
  assert.equal(await fs.readFile(path.join(created.path, "SKILL.md"), "utf8"), before);
  check(true, "Initialization refuses invalid names and never overwrites an existing skill");
  await fs.writeFile(path.join(created.path, "SKILL.md"), before + "\n[Missing](references/absent.md)\n");
  assert.equal(runPython([validate, created.path], false).ok, false);
  await fs.writeFile(path.join(created.path, "SKILL.md"), before);
  check(true, "Validation rejects a broken local resource link");
  await localCommand("/skills reload");
  check(Boolean(findSkill("meeting-notes")), "A newly created skill is discoverable through the real reload command");

  const helper = path.join(skillsDir, "excel-skill", "scripts", "office_helper.py");
  const probe = runPython([helper, "probe"]);
  check(probe.ok && probe.python.executable && Object.hasOwn(probe.modules, "openpyxl"), "The installed Office helper probes actual Python and application availability");
  const fixtureScript = path.join(root, "fixtures.py");
  await fs.writeFile(fixtureScript, String.raw`import json, sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
ct = 'http://schemas.openxmlformats.org/package/2006/content-types'
rel = 'http://schemas.openxmlformats.org/package/2006/relationships'
r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def save(ext, main, kind, body, extra):
    parts = {'[Content_Types].xml': '<Types xmlns="'+ct+'"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/'+main+'" ContentType="application/vnd.openxmlformats-officedocument.'+kind+'.main+xml"/></Types>', '_rels/.rels':'<Relationships xmlns="'+rel+'"><Relationship Id="rId1" Type="'+r+'/officeDocument" Target="'+main+'"/></Relationships>', main:body}
    parts.update(extra)
    with zipfile.ZipFile(root / ('测试 文件.'+ext), 'w') as archive:
        for name, data in parts.items(): archive.writestr(name, data)
save('docx', 'word/document.xml', 'wordprocessingml.document', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello document</w:t></w:r></w:p></w:body></w:document>', {})
save('pptx', 'ppt/presentation.xml', 'presentationml.presentation', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="'+r+'"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>', {'ppt/_rels/presentation.xml.rels':'<Relationships xmlns="'+rel+'"><Relationship Id="rId1" Type="'+r+'/slide" Target="slides/slide1.xml"/></Relationships>', 'ppt/slides/slide1.xml':'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>Hello slide</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>'})
save('xlsx', 'xl/workbook.xml', 'spreadsheetml.sheet', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="'+r+'"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>', {'xl/_rels/workbook.xml.rels':'<Relationships xmlns="'+rel+'"><Relationship Id="rId1" Type="'+r+'/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1+1</f><v>2</v></c></row><row r="2"><c r="A2"><f>1+1</f><v/></c><c r="B2" t="e"><v>#REF!</v></c></row></sheetData></worksheet>'})
with zipfile.ZipFile(root / 'unsafe.docx','w') as archive: archive.writestr('../escape','unsafe')
print(json.dumps({'ok':True}))
`);
  runPython([fixtureScript, root]);
  const document = runPython([helper, "inspect", path.join(root, "测试 文件.docx")]);
  const slides = runPython([helper, "inspect", path.join(root, "测试 文件.pptx")]);
  const workbook = runPython([helper, "validate", path.join(root, "测试 文件.xlsx")]);
  check(document.summary.text_samples.includes("Hello document") && slides.summary.slide_count === 1 && slides.summary.slides[0].text === "Hello slide", "Office inspection extracts real DOCX and PPTX content from Unicode paths");
  check(workbook.summary.formula_count === 2 && workbook.summary.error_cell_count === 1 && workbook.summary.formula_missing_cached_value_count === 1 && workbook.validation.formulas_recalculated === false,
    "Workbook inspection reports formulas, errors and missing caches without claiming recalculation");
  check(runPython([helper, "validate", path.join(root, "unsafe.docx")], false).ok === false, "Office validation rejects a ZIP path escape without extracting files");

  const edited = path.join(skillsDir, "word-skill", "references", "word-editing.md");
  await fs.appendFile(edited, "\nUser customization.\n");
  await bootstrapSkills(root);
  check((await fs.readFile(edited, "utf8")).endsWith("User customization.\n"), "Startup preserves user edits to bundled supporting resources");
  await setSkillState("skill-creator", "close");
  check(!formatSkillsSystemReminder(getModelVisibleSkills()).includes("invoke skill-creator before writing") && (await skillTool.call({ skill: "skill-creator" }, { cwd: root })).isError,
    "Closing skill-creator removes its automatic guidance and blocks invocation");
  await localCommand("/agent-skill delete ppt-skill --yes");
  await bootstrapAgentSkills(); await bootstrapSkills(root);
  check(!findSkill("ppt-skill") && Boolean(findSkill("excel-skill")), "Deleting one Office skill persists across startup without affecting other built-ins");
  const externalResources = path.join(root, "external-resources");
  await fs.mkdir(externalResources);
  const scripts = path.join(skillsDir, "word-skill", "scripts");
  await fs.rm(scripts, { recursive: true });
  await fs.symlink(externalResources, scripts, process.platform === "win32" ? "junction" : "dir");
  check((await ensureBuiltinSkills()).some((warning) => warning.includes("not a regular directory")) && (await fs.readdir(externalResources)).length === 0,
    "Installation refuses a supporting-directory symlink without writing outside the skill");
  const linkedHome = path.join(root, "linked-home"), externalSkills = path.join(root, "external-skills");
  await fs.mkdir(linkedHome); await fs.mkdir(externalSkills);
  await fs.symlink(externalSkills, path.join(linkedHome, "skills"), process.platform === "win32" ? "junction" : "dir");
  process.env.CCAGENT_HOME = linkedHome;
  await bootstrapAgentSkills();
  check((await ensureBuiltinSkills()).some((warning) => warning.includes("not a regular directory")) && (await fs.readdir(externalSkills)).length === 0,
    "Installation refuses a skill-root symlink before creating any external resources");
  console.log(`\nAll ${checks} built-in skill checks passed (loopback account only; no model calls).`);
} finally {
  globalThis.fetch = previousFetch; clearSkills();
  await account.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await fs.rm(root, { recursive: true, force: true });
}
