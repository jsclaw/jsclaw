import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFrontmatter, parseSkill, loadSkills, installSkill, removeSkill,
  skillMatches, matchSkills, buildSkillContext,
} from '../src/skills.js';
import { tempConfig } from './helpers.js';

const DEPLOY_SKILL = `---
name: deploy-helper
description: "Helps with deployments"
version: 1.0.0
trigger: "deploy|ship|push to prod"
tools: [shell, http]
config:
  environment:
    type: string
    default: staging
---
# Deploy Helper

When asked to deploy:
1. Run the test suite first
2. Tag the release
`;

test('parseFrontmatter splits data and body', () => {
  const { data, body } = parseFrontmatter(DEPLOY_SKILL);
  assert.equal(data.name, 'deploy-helper');
  assert.equal(data.description, 'Helps with deployments');
  assert.equal(data.version, '1.0.0');
  assert.deepEqual(data.tools, ['shell', 'http']);
  assert.equal(data.config.environment.type, 'string');
  assert.equal(data.config.environment.default, 'staging');
  assert.ok(body.startsWith('# Deploy Helper'));
});

test('parseFrontmatter handles documents without frontmatter', () => {
  const { data, body } = parseFrontmatter('just some markdown');
  assert.deepEqual(data, {});
  assert.equal(body, 'just some markdown');
});

test('frontmatter block lists work', () => {
  const { data } = parseFrontmatter(`---
name: x
description: y
tools:
  - shell
  - browser
---
body`);
  assert.deepEqual(data.tools, ['shell', 'browser']);
});

test('parseSkill validates required fields', () => {
  assert.throws(() => parseSkill('---\ndescription: no name\n---\nbody'), /name/);
  assert.throws(() => parseSkill('---\nname: no-desc\n---\nbody'), /description/);
  // version stays a string, not a number
  const skill = parseSkill(DEPLOY_SKILL);
  assert.equal(skill.version, '1.0.0');
  assert.equal(typeof skill.version, 'string');
});

test('keyword triggers are case-insensitive and pipe-separated', () => {
  const skill = parseSkill(DEPLOY_SKILL);
  assert.ok(skillMatches(skill, { text: 'Can you DEPLOY the api?' }));
  assert.ok(skillMatches(skill, { text: 'ship it' }));
  assert.ok(skillMatches(skill, { text: 'time to push to prod now' }));
  assert.ok(!skillMatches(skill, { text: 'what is the weather' }));
});

test('regex triggers', () => {
  const skill = parseSkill(`---
name: r
description: regex
trigger: "/^deploy .+ to (staging|prod)$/i"
---
body`);
  assert.ok(skillMatches(skill, { text: 'Deploy api-v2 to prod' }));
  assert.ok(!skillMatches(skill, { text: 'deploy it' }));
});

test('attachment and always-on triggers', () => {
  const img = parseSkill('---\nname: i\ndescription: d\ntrigger: "attachment:image"\n---\nb');
  assert.ok(skillMatches(img, { text: '', attachments: [{ type: 'image' }] }));
  assert.ok(!skillMatches(img, { text: 'an image', attachments: [] }));

  const always = parseSkill('---\nname: a\ndescription: d\ntrigger: "*"\n---\nb');
  assert.ok(skillMatches(always, { text: 'anything' }));

  // trigger defaults to always-on
  const noTrigger = parseSkill('---\nname: n\ndescription: d\n---\nb');
  assert.equal(noTrigger.trigger, '*');
});

test('load/install/remove lifecycle', () => {
  const config = tempConfig();
  mkdirSync(config.skillsDir, { recursive: true });

  // Source file elsewhere
  const src = join(config.dataDir, 'incoming-skill.md');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(src, DEPLOY_SKILL);

  const installed = installSkill(src, config);
  assert.equal(installed.name, 'deploy-helper');
  assert.ok(installed.path.endsWith('deploy-helper.md'));

  const skills = loadSkills(config);
  assert.equal(skills.length, 1);

  // Invalid skill files are skipped, not fatal
  writeFileSync(join(config.skillsDir, 'broken.md'), '---\ndescription: nameless\n---\nx');
  assert.equal(loadSkills(config).length, 1);

  assert.ok(removeSkill('deploy-helper', config));
  assert.ok(!removeSkill('deploy-helper', config));
  assert.equal(loadSkills(config).length, 0);
});

test('buildSkillContext formats matched skills for the prompt', () => {
  const skill = parseSkill(DEPLOY_SKILL);
  const matched = matchSkills([skill], { text: 'deploy please' });
  const ctx = buildSkillContext(matched);
  assert.ok(ctx.startsWith('# Active Skills'));
  assert.ok(ctx.includes('## Skill: deploy-helper'));
  assert.ok(ctx.includes('Run the test suite first'));
  assert.equal(buildSkillContext([]), '');
});

// --- Folder skills (#47 audit finding 1) ---

test('loadSkills discovers folder skills alongside flat files', (t) => {
  const config = tempConfig();
  mkdirSync(join(config.skillsDir, 'folder-skill'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'folder-skill', 'SKILL.md'),
    '---\nname: folder-skill\ndescription: lives in a folder\n---\nBody here.');
  writeFileSync(join(config.skillsDir, 'folder-skill', 'helper.sh'), 'echo resource');
  writeFileSync(join(config.skillsDir, 'flat.md'),
    '---\nname: flat\ndescription: flat file\n---\nFlat body.');
  mkdirSync(join(config.skillsDir, 'not-a-skill'), { recursive: true }); // no SKILL.md

  const skills = loadSkills(config);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['flat', 'folder-skill']);
  const folder = skills.find((s) => s.name === 'folder-skill');
  assert.match(folder.path, /folder-skill\/SKILL\.md$/);
});

test('installSkill copies folder skills with their resources; removeSkill deletes them', (t) => {
  const config = tempConfig();
  const src = join(config.dataDir, 'incoming', 'my-skill');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), '---\nname: my-skill\ndescription: folder install\n---\nUse helper.py.');
  writeFileSync(join(src, 'helper.py'), 'print("hi")');

  // install by folder path
  const installed = installSkill(src, config);
  assert.equal(installed.name, 'my-skill');
  assert.ok(existsSync(join(config.skillsDir, 'my-skill', 'SKILL.md')));
  assert.ok(existsSync(join(config.skillsDir, 'my-skill', 'helper.py')), 'resources copied');

  // install by SKILL.md path resolves the folder too
  const again = installSkill(join(src, 'SKILL.md'), config);
  assert.equal(again.name, 'my-skill');

  assert.equal(removeSkill('my-skill', config), true);
  assert.equal(existsSync(join(config.skillsDir, 'my-skill')), false);
  assert.equal(removeSkill('my-skill', config), false);
});

test('a real openclaw bundled skill loads when the layout exists', (t) => {
  const fixture = '/usr/local/lib/node_modules/openclaw/skills/gh-issues';
  if (!existsSync(join(fixture, 'SKILL.md'))) return t.skip('openclaw not installed');
  const config = tempConfig();
  const installed = installSkill(fixture, config);
  assert.equal(installed.name, 'gh-issues');
  const skills = loadSkills(config);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'gh-issues');
});
