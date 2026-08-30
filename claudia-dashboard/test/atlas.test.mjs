import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_ATLAS_DIRECTORY_DEPTH,
  MAX_ATLAS_DIRECTORY_VISITS,
  MAX_ATLAS_EDGES,
  MAX_ATLAS_FILE_BYTES,
  MAX_ATLAS_NODES,
  MAX_ATLAS_TOTAL_BYTES,
  assignAtlasPosition,
  loadAtlas,
} from '../atlas.mjs';

async function withWorkspace(run) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'claudia-atlas-'));
  const workspace = path.join(sandbox, 'workspace');
  await mkdir(workspace);
  try {
    await run(workspace, sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function put(workspace, relativePath, contents = '') {
  const destination = path.join(workspace, ...relativePath.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

function nodeByPath(atlas, notePath) {
  const node = atlas.nodes.find((candidate) => candidate.path === notePath);
  assert.ok(node, `Expected node ${notePath}`);
  return node;
}

function hasEdge(atlas, first, second) {
  return atlas.edges.some((edge) => (
    (edge.source === first && edge.target === second)
    || (edge.source === second && edge.target === first)
  ));
}

test('scanner uses a closed allowlist, excludes generated trees, and refuses symlinks', async () => {
  await withWorkspace(async (workspace, sandbox) => {
    await put(workspace, 'MEMORY.md', '# Memory\n\nULTRA_PRIVATE_BODY /srv/private/vault');
    await put(workspace, 'rogue.md', 'ROGUE_SECRET');
    await put(workspace, 'memory/daily.md', '# Daily');
    await put(workspace, 'skills/atlas/SKILL.md', '# Skill');
    await put(workspace, 'templates/note.md', '# Template');
    await put(workspace, 'claudia-dashboard/README.md', '# Dashboard');
    await put(workspace, '.git/leak.md', 'GIT_SECRET');
    await put(workspace, '.obsidian/leak.md', 'OBSIDIAN_SECRET');
    await put(workspace, 'public-edition/leak.md', 'PUBLIC_EDITION_SECRET');
    await put(workspace, 'memory/generated/leak.md', 'GENERATED_SECRET');
    await put(workspace, 'skills/mirrors/leak.md', 'MIRROR_SECRET');
    await put(workspace, 'templates/public-edition/leak.md', 'NESTED_PUBLIC_SECRET');
    await put(workspace, 'claudia-dashboard/node_modules/pkg/README.md', 'MODULE_SECRET');

    const externalFile = path.join(sandbox, 'outside.md');
    await writeFile(externalFile, 'SYMLINK_FILE_SECRET /srv/private/outside');
    await symlink(externalFile, path.join(workspace, 'memory', 'linked.md'));
    const externalDirectory = path.join(sandbox, 'external-skills');
    await mkdir(externalDirectory);
    await writeFile(path.join(externalDirectory, 'LEAK.md'), 'SYMLINK_DIRECTORY_SECRET');
    await symlink(externalDirectory, path.join(workspace, 'skills', 'linked-directory'));

    const atlas = await loadAtlas(workspace);
    assert.deepEqual(atlas.nodes.map((node) => node.path), [
      'claudia-dashboard/README.md',
      'MEMORY.md',
      'memory/daily.md',
      'skills/atlas/SKILL.md',
      'templates/note.md',
    ]);
    const serialized = JSON.stringify(atlas);
    assert.doesNotMatch(serialized, /SECRET|ULTRA_PRIVATE_BODY|\/home\/|claudia-atlas-/);
    assert.equal(atlas.readOnly, true);
  });
});

test('links resolve exact and sibling paths before unique-basename fallback', async () => {
  await withWorkspace(async (workspace) => {
    await put(workspace, 'MEMORY.md', [
      '[[Shared]]',
      '[[memory/Exact#Heading|Exact alias]]',
      '[Unique](templates/Unique.md#part)',
      '[Remote](https://example.invalid/Remote.md)',
    ].join('\n'));
    await put(workspace, 'memory/Local.md', '[[Shared]]');
    await put(workspace, 'memory/Shared.md', '# Local shared');
    await put(workspace, 'templates/Shared.md', '# Other shared');
    await put(workspace, 'memory/Exact.md', '# Exact');
    await put(workspace, 'templates/Unique.md', '# Unique');

    const atlas = await loadAtlas(workspace);
    assert.equal(hasEdge(atlas, 'memory/Local.md', 'memory/Shared.md'), true, 'sibling match should win');
    assert.equal(hasEdge(atlas, 'MEMORY.md', 'memory/Exact.md'), true, 'vault-exact match should resolve');
    assert.equal(hasEdge(atlas, 'MEMORY.md', 'templates/Unique.md'), true, 'relative Markdown link should resolve');
    assert.equal(hasEdge(atlas, 'MEMORY.md', 'memory/Shared.md'), false, 'ambiguous basename must not resolve');
    assert.equal(hasEdge(atlas, 'MEMORY.md', 'templates/Shared.md'), false, 'ambiguous basename must not resolve');
    assert.equal(atlas.edges.length, 3);
  });
});

test('classification follows Brain Atlas precedence and six-lobe semantics', async () => {
  await withWorkspace(async (workspace) => {
    await put(workspace, 'MEMORY.md', [
      '---',
      'kind: person',
      'brain_region: occipital',
      'tags: [project]',
      '---',
      '#project frontmatter still wins',
    ].join('\n'));
    await put(workspace, 'skills/Projects/tagged.md', '#person tag wins over folder');
    await put(workspace, 'skills/Projects/folder.md', 'Folder fallback');
    await put(workspace, 'memory/2026-08-30.md', 'Date filename');
    await put(workspace, 'templates/Home.md', 'Index filename');
    await put(workspace, 'templates/plain.md', 'Default concept');
    await put(workspace, 'templates/thread.md', '---\ntype: work-thread\n---\nThread');
    await put(workspace, 'templates/list-tag.md', '---\ntags:\n  - decision\n---\nDecision');
    await put(workspace, 'templates/000-link-hub.md', Array.from(
      { length: 10 },
      (_value, index) => `[[z-link-${String(index).padStart(2, '0')}]]`,
    ).join(' '));
    for (let index = 0; index < 10; index += 1) {
      await put(workspace, `templates/z-link-${String(index).padStart(2, '0')}.md`, 'Leaf');
    }

    const atlas = await loadAtlas(workspace);
    const frontmatter = nodeByPath(atlas, 'MEMORY.md');
    assert.equal(frontmatter.kind, 'person');
    assert.equal(frontmatter.classificationSource, 'frontmatter');
    assert.equal(frontmatter.region, 'occipital');
    assert.equal(frontmatter.regionLabel, 'OCCIPITAL');
    assert.equal(frontmatter.color, '#d4d0c4');

    assert.deepEqual(
      ['skills/Projects/tagged.md', 'skills/Projects/folder.md', 'memory/2026-08-30.md', 'templates/Home.md', 'templates/plain.md', 'templates/thread.md', 'templates/list-tag.md']
        .map((notePath) => {
          const node = nodeByPath(atlas, notePath);
          return [node.kind, node.classificationSource, node.region];
        }),
      [
        ['person', 'tag', 'temporal'],
        ['project', 'folder', 'frontal'],
        ['dailyNote', 'filename', 'cerebellum'],
        ['index', 'filename', 'stem'],
        ['concept', 'default', 'parietal'],
        ['workThread', 'frontmatter', 'parietal'],
        ['decision', 'tag', 'frontal'],
      ],
    );
    assert.deepEqual(atlas.regions.map((region) => region.id), [
      'frontal', 'parietal', 'temporal', 'occipital', 'cerebellum', 'stem',
    ]);
    const linkClassified = nodeByPath(atlas, 'templates/000-link-hub.md');
    assert.equal(linkClassified.kind, 'source');
    assert.equal(linkClassified.classificationSource, 'linkBehavior');
  });
});

test('node and edge output is capped, internally consistent, and finite', { timeout: 30_000 }, async () => {
  await withWorkspace(async (workspace) => {
    const count = MAX_ATLAS_NODES + 2;
    const writes = [];
    for (let index = 0; index < count; index += 1) {
      const current = String(index).padStart(4, '0');
      const links = Array.from({ length: 5 }, (_value, offset) => {
        const target = String((index + offset + 1) % count).padStart(4, '0');
        return `[[n${target}]]`;
      });
      writes.push(put(workspace, `memory/n${current}.md`, links.join(' ')));
      if (writes.length === 100) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);

    const atlas = await loadAtlas(workspace);
    assert.equal(atlas.nodes.length, MAX_ATLAS_NODES);
    assert.equal(atlas.edges.length, MAX_ATLAS_EDGES);
    assert.equal(atlas.stats.nodes, MAX_ATLAS_NODES);
    assert.equal(atlas.stats.edges, MAX_ATLAS_EDGES);
    assert.ok(atlas.stats.hubs >= 1 && atlas.stats.hubs <= atlas.stats.nodes);
    assert.equal(atlas.stats.connected + atlas.stats.unlinked, atlas.stats.nodes);
    assert.ok(atlas.stats.connected <= MAX_ATLAS_NODES);
    assert.ok(atlas.stats.unlinked <= MAX_ATLAS_NODES);
    assert.ok(Number.isFinite(atlas.stats.density));
    assert.ok(atlas.stats.density >= 0 && atlas.stats.density <= 1);
    assert.equal(atlas.stats.truncated, true);
    assert.deepEqual(atlas.stats.limits, {
      nodes: MAX_ATLAS_NODES,
      edges: MAX_ATLAS_EDGES,
      fileBytes: MAX_ATLAS_FILE_BYTES,
      totalBytes: MAX_ATLAS_TOTAL_BYTES,
      directoryVisits: MAX_ATLAS_DIRECTORY_VISITS,
      directoryDepth: MAX_ATLAS_DIRECTORY_DEPTH,
    });

    const ids = new Set(atlas.nodes.map((node) => node.id));
    const edgeIds = new Set(atlas.edges.map((edge) => edge.id));
    assert.equal(ids.size, atlas.nodes.length);
    assert.equal(edgeIds.size, atlas.edges.length);
    for (const edge of atlas.edges) {
      assert.ok(ids.has(edge.source));
      assert.ok(ids.has(edge.target));
      assert.notEqual(edge.source, edge.target);
    }
    for (const node of atlas.nodes) {
      assert.ok(Number.isFinite(node.position.x));
      assert.ok(Number.isFinite(node.position.y));
      assert.ok(Number.isFinite(node.position.z));
      assert.ok(node.degree >= 0 && node.degree < MAX_ATLAS_NODES);
    }
  });
});

test('directory visits and depth are bounded for adversarial empty and deep trees', { timeout: 30_000 }, async () => {
  await withWorkspace(async (workspace) => {
    await put(workspace, 'memory/00-shallow.md', 'Visible');
    let deepDirectory = 'memory';
    for (let depth = 0; depth < MAX_ATLAS_DIRECTORY_DEPTH + 3; depth += 1) {
      deepDirectory += `/d${String(depth).padStart(2, '0')}`;
    }
    await put(workspace, `${deepDirectory}/too-deep.md`, 'DEEP_TREE_SECRET');

    const pending = [];
    for (let index = 0; index < MAX_ATLAS_DIRECTORY_VISITS + 8; index += 1) {
      pending.push(mkdir(path.join(workspace, 'skills', `empty-${String(index).padStart(4, '0')}`), { recursive: true }));
      if (pending.length === 100) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);

    const first = await loadAtlas(workspace);
    const second = await loadAtlas(workspace);
    assert.deepEqual(first, second);
    assert.ok(first.nodes.some((node) => node.path === 'memory/00-shallow.md'));
    assert.equal(first.nodes.some((node) => node.path.endsWith('/too-deep.md')), false);
    assert.equal(first.stats.directoriesVisited, MAX_ATLAS_DIRECTORY_VISITS);
    assert.equal(first.stats.maxDirectoryDepth, MAX_ATLAS_DIRECTORY_DEPTH);
    assert.equal(first.stats.truncated, true);
    assert.equal(first.stats.limits.directoryVisits, MAX_ATLAS_DIRECTORY_VISITS);
    assert.equal(first.stats.limits.directoryDepth, MAX_ATLAS_DIRECTORY_DEPTH);
    assert.doesNotMatch(JSON.stringify(first), /DEEP_TREE_SECRET/);
  });
});

test('per-file and total byte budgets fail closed', { timeout: 30_000 }, async () => {
  await withWorkspace(async (workspace) => {
    await put(workspace, 'memory/00-too-large.md', Buffer.alloc(MAX_ATLAS_FILE_BYTES + 1, 0x61));
    for (let index = 0; index < 34; index += 1) {
      await put(workspace, `memory/blob-${String(index).padStart(2, '0')}.md`, Buffer.alloc(MAX_ATLAS_FILE_BYTES));
    }
    const atlas = await loadAtlas(workspace);
    assert.equal(atlas.nodes.some((node) => node.path === 'memory/00-too-large.md'), false);
    assert.equal(atlas.stats.bytesRead, MAX_ATLAS_TOTAL_BYTES);
    assert.ok(atlas.stats.bytesRead <= MAX_ATLAS_TOTAL_BYTES);
    assert.ok(atlas.stats.skippedFiles >= 3);
    assert.equal(atlas.stats.truncated, true);
  });
});

test('adapter is deterministic and never serializes Markdown bodies or absolute paths', async () => {
  await withWorkspace(async (workspace) => {
    await put(workspace, 'MEMORY.md', '[[memory/alpha]]\nTOP_SECRET_TOKEN /srv/private/brain');
    await put(workspace, 'memory/alpha.md', 'Alpha words and [[templates/beta]].');
    await put(workspace, 'templates/beta.md', 'Beta words.');

    const first = await loadAtlas(workspace);
    const second = await loadAtlas(workspace);
    assert.deepEqual(first, second);
    assert.equal(first.stats.hubs, 1);
    assert.equal(first.stats.connected, 3);
    assert.equal(first.stats.unlinked, 0);
    assert.equal(first.stats.density, 0.666667);
    assert.deepEqual(
      assignAtlasPosition({ id: 'memory/alpha.md', path: 'memory/alpha.md', kind: 'concept', region: 'parietal', hub: false }),
      assignAtlasPosition({ id: 'memory/alpha.md', path: 'memory/alpha.md', kind: 'concept', region: 'parietal', hub: false }),
    );
    for (const node of first.nodes) {
      assert.deepEqual(Object.keys(node).sort(), [
        'classificationSource', 'color', 'degree', 'hub', 'id', 'kind', 'kindLabel',
        'modifiedAt', 'path', 'position', 'region', 'regionLabel', 'title', 'wordCount',
      ]);
      assert.equal('raw' in node, false);
      assert.equal('html' in node, false);
    }
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /TOP_SECRET_TOKEN|\/home\/openclaw|claudia-atlas-/);
  });
});
