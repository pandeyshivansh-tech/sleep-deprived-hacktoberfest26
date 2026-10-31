import { createHash } from 'node:crypto';
import { makeFakeFetch } from './fake-fetch.js';
import { makeNpmTarball, makeSourceTarball } from './tar-builder.js';

export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const FIXED_NOW = () => new Date('2026-11-01T00:00:00.000Z');

// A complete fictional release: registry metadata, the published tarball and the
// source snapshot, served by a fake fetch. Nothing touches the network.
export function makeScenario({
  name = 'demo-pkg',
  version = '1.0.0',
  packageFiles,
  sourceFiles,
  gitHead = COMMIT,
  repository = 'https://github.com/acme/demo-pkg',
  packageTarball = makeNpmTarball(packageFiles),
  sourceTarball = sourceFiles ? makeSourceTarball(sourceFiles, { commit: COMMIT }) : null,
  integrity = `sha512-${createHash('sha512').update(packageTarball).digest('base64')}`,
  extraRoutes = {},
}) {
  const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  const metadata = {
    name,
    version,
    ...(gitHead ? { gitHead } : {}),
    repository: { type: 'git', url: `git+${repository}.git` },
    dist: { tarball: tarballUrl, integrity },
  };
  const repoPath = repository.replace('https://github.com/', '');
  const routes = {
    [`https://registry.npmjs.org/${name}/${version}`]: { body: metadata },
    [tarballUrl]: { body: packageTarball },
    ...(sourceTarball && gitHead ? { [`https://codeload.github.com/${repoPath}/tar.gz/${gitHead}`]: { body: sourceTarball } } : {}),
    ...(sourceTarball ? { [`https://codeload.github.com/${repoPath}/tar.gz/refs/tags/v${version}`]: { body: sourceTarball } } : {}),
    ...extraRoutes,
  };
  const fake = makeFakeFetch(routes);
  return { metadata, packageTarball, sourceTarball, tarballUrl, routes, ...fake };
}

export const manifest = (extra = {}) => JSON.stringify({ name: 'demo-pkg', version: '1.0.0', ...extra }, null, 2);
