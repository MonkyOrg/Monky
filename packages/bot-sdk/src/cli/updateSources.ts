import path from 'node:path';
import type { BotProject, BotUpdateSource, GitHubReleaseSource } from '../tooling/config';
import {
  copyLocalUpdateArchive,
  downloadHttpsUpdateArchive,
  downloadReleaseAsset,
  fetchLatestRelease,
  parseVersion,
  readPackageManifestFromTarball,
  withTemporaryDownload,
  type VerifiedTarballManifest,
} from './updateReleases';

export type ConfiguredUpdateSource = { type: 'github'; releases: GitHubReleaseSource } | BotUpdateSource;

export interface UpdateCandidate {
  version: string;
  htmlUrl?: string;
  withVerifiedArchive(action: (file: string) => void | Promise<void>): Promise<void>;
}

export function configuredUpdateSource(project: BotProject): ConfiguredUpdateSource {
  const { releases, updateSource } = project.definition;
  if (releases && updateSource) throw new Error('Configure either monkyBot.releases or monkyBot.updateSource, not both.');
  if (releases) return { type: 'github', releases };
  if (updateSource) {
    if (updateSource.type !== 'https' && updateSource.type !== 'file') {
      throw new Error('Unsupported bot update source.');
    }
    return updateSource;
  }
  throw new Error(`Updates are not configured for ${project.definition.displayName}. Configure package.json.monkyBot.releases (GitHub recommended) or monkyBot.updateSource (https/file).`);
}

function verifyIdentity(project: BotProject, manifest: VerifiedTarballManifest, expectedVersion?: string): void {
  if (manifest.name !== project.manifest.name || manifest.cliName !== project.definition.cliName ||
      (expectedVersion !== undefined && manifest.version !== expectedVersion)) {
    throw new Error('The update archive does not match the expected bot package (name, CLI or version).');
  }
}

export async function withUpdateCandidate(
  project: BotProject,
  includePrerelease: boolean,
  action: (candidate: UpdateCandidate | null) => void | Promise<void>,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const source = configuredUpdateSource(project);
  if (source.type === 'github') {
    const latest = await fetchLatestRelease(source.releases, project.definition, includePrerelease, env);
    return action(latest ? {
      version: latest.version,
      htmlUrl: latest.htmlUrl,
      withVerifiedArchive: (install) => withTemporaryDownload(project.definition.cliName, async (directory) => {
        const file = path.join(directory, latest.assetName);
        await downloadReleaseAsset(source.releases, latest, file, env);
        verifyIdentity(project, readPackageManifestFromTarball(file), latest.version);
        await install(file);
      }),
    } : null);
  }
  await withTemporaryDownload(project.definition.cliName, async (directory) => {
    const file = path.join(directory, 'update.tgz');
    if (source.type === 'https') {
      await downloadHttpsUpdateArchive(source, file, env);
    } else {
      // Resolve from the installed package, independently of an operator's or PM2's working directory.
      await copyLocalUpdateArchive(path.resolve(project.root, source.path), file);
    }
    const manifest = readPackageManifestFromTarball(file);
    verifyIdentity(project, manifest);
    const parsed = parseVersion(manifest.version);
    if (!parsed) throw new Error('The update archive version must be valid SemVer.');
    if (!includePrerelease && parsed.prerelease.length) return action(null);
    await action({
      version: manifest.version,
      // Keep the verified snapshot until installation finishes; never reopen a changing author-supplied file.
      withVerifiedArchive: async (install) => { await install(file); },
    });
  });
}
