import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
let installRoot: string | undefined;

afterEach(async () => {
  if (installRoot !== undefined) await rm(installRoot, { recursive: true, force: true });
  installRoot = undefined;
});

describe("CI production install", () => {
  it("runs the CLI with only its production workspace dependencies", async () => {
    installRoot = await mkdtemp(join(tmpdir(), "supply-chain-ci-production-"));
    const packageDirectory = join(installRoot, "packages", "ci");
    await mkdir(packageDirectory, { recursive: true });

    const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as {
      workspaces: string[];
    };
    rootManifest.workspaces = ["packages/ci"];
    await writeFile(join(installRoot, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);

    const lockfile = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8")) as {
      packages: Record<string, { workspaces?: string[] } | undefined>;
    };
    const ciLockEntry = lockfile.packages["packages/ci"] as { dependencies?: Record<string, string> } | undefined;
    expect(ciLockEntry?.dependencies?.semver).toBe("^7.8.5");
    lockfile.packages[""]!.workspaces = ["packages/ci"];
    for (const path of Object.keys(lockfile.packages)) {
      if (path.startsWith("packages/") && path !== "packages/ci") delete lockfile.packages[path];
      if (path.startsWith("node_modules/@leanish/") && path !== "node_modules/@leanish/supply-chain-ci") {
        delete lockfile.packages[path];
      }
    }
    await writeFile(join(installRoot, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);

    await cp(join(repository, "packages/ci/package.json"), join(packageDirectory, "package.json"));
    await cp(join(repository, "packages/ci/src"), join(packageDirectory, "src"), { recursive: true });

    const install = spawnSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--workspace", "packages/ci"], {
      cwd: installRoot,
      encoding: "utf8",
    });
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);

    const installedWorkspaces = await readdir(join(installRoot, "node_modules", "@leanish"));
    expect(installedWorkspaces).toEqual(["supply-chain-ci"]);
    for (const dependency of ["semver", "yaml"]) {
      const resolved = spawnSync(process.execPath, ["-p", `require.resolve(${JSON.stringify(dependency)})`], {
        cwd: packageDirectory,
        encoding: "utf8",
      });
      expect(resolved.status, resolved.stderr).toBe(0);
      const pathFromInstall = relative(await realpath(installRoot), await realpath(resolved.stdout.trim()));
      expect(pathFromInstall.startsWith(`..${sep}`), `${dependency} resolved outside ${installRoot}: ${resolved.stdout.trim()}`).toBe(false);
    }

    const cli = spawnSync(process.execPath, ["src/cli.ts", "--help"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });
    expect(cli.status).toBe(2);
    expect(`${cli.stdout}\n${cli.stderr}`).toContain("usage:");
  });
});
