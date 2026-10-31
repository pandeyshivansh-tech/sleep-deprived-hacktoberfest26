import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepository } from '../src/source/repository.js';

const ok = (input, expected) => {
  const result = parseRepository(input);
  assert.equal(result.ok, true, JSON.stringify(input));
  assert.deepEqual(
    { owner: result.owner, repo: result.repo, directory: result.directory, url: result.url },
    { directory: null, ...expected },
    JSON.stringify(input),
  );
};

test('understands the repository URL shapes seen in real packages', () => {
  const expected = { owner: 'debug-js', repo: 'debug', url: 'https://github.com/debug-js/debug' };
  ok('git://github.com/debug-js/debug.git', expected);
  ok({ url: 'git+https://github.com/debug-js/debug.git', type: 'git' }, expected);
  ok({ url: 'git+ssh://git@github.com/debug-js/debug.git' }, expected);
  ok('ssh://git@github.com/debug-js/debug', expected);
  ok('git@github.com:debug-js/debug.git', expected);
  ok('https://github.com/debug-js/debug', expected);
  ok('https://www.github.com/debug-js/debug/', expected);
  ok('github:debug-js/debug', expected);
  ok('debug-js/debug', expected);
  ok('git+https://github.com/debug-js/debug.git#main', expected);
  ok('https://github.com/debug-js/debug/tree/main/src', expected);
});

test('reads and normalizes the monorepo directory', () => {
  ok({ url: 'https://github.com/babel/babel.git', directory: 'packages/babel-core' }, {
    owner: 'babel',
    repo: 'babel',
    url: 'https://github.com/babel/babel',
    directory: 'packages/babel-core',
  });
  assert.equal(parseRepository({ url: 'a/b', directory: './pkgs//x/' }).directory, 'pkgs/x');
  assert.equal(parseRepository({ url: 'a/b', directory: '' }).directory, null);
});

test('rejects unsafe repository directories', () => {
  for (const directory of ['../escape', 'a/../../b', '/abs', 'a\\b', 42]) {
    const result = parseRepository({ url: 'https://github.com/a/b', directory });
    assert.equal(result.ok, false, String(directory));
    assert.match(result.reason, /repository\.directory/);
  }
});

test('reports other hosts and missing fields as unsupported, never guesses', () => {
  for (const input of ['https://gitlab.com/a/b', 'https://bitbucket.org/a/b', 'git@gitlab.com:a/b.git', 'https://github.com.evil.com/a/b']) {
    const result = parseRepository(input);
    assert.equal(result.ok, false, input);
    assert.match(result.reason, /Only GitHub|could not be understood|not a valid/);
  }
  for (const input of [undefined, null, {}, { type: 'git' }, 42]) {
    assert.match(parseRepository(input).reason, /no repository field/);
  }
});

test('rejects owner and repo names that could change the request path', () => {
  for (const input of ['https://github.com/a/..', 'https://github.com/../b', 'https://github.com/a b/c', 'https://github.com/-bad/repo', 'https://github.com/only-owner', 'ftp://github.com/a/b', 'file:///etc/passwd']) {
    assert.equal(parseRepository(input).ok, false, input);
  }
});
