// create version for release for github build workflow
//
// Unified for both triggers (tag push `v*` and workflow_dispatch):
//   1. if the commit being released already carries a `v*` tag (the pushed
//      tag) -> reuse it, so the release attaches to that exact tag
//   2. otherwise -> `v<pkgVer>` (workflow_dispatch case); if that tag
//      already exists on a DIFFERENT commit, fall back to
//      `v<pkgVer>.<random>` instead of moving/failing

const fs = require('fs');
const { execSync } = require('child_process');
const type = process.argv[2];

if (type && process.env.GITHUB_ENV) {
    const pkgVer = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const rando = ((Math.random() * 0xfff) & 0xfff).toString().padStart(4,0);
    const wanted = `v${pkgVer}`;

    const headVTtags = execSync('git tag --points-at HEAD', { encoding: 'utf8' })
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('v'));

    const tagExists = tag => {
        try {
            execSync(`git rev-parse -q --verify "refs/tags/${tag}"`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    };

    const releaseTag =
        headVTtags.length ? headVTtags.sort().at(-1) :
        tagExists(wanted) ? `${wanted}.${rando}` :
        wanted;

    console.log({ type, version: pkgVer, releaseTag });

    // write version to GITHUB_ENV file
    fs.appendFileSync(process.env.GITHUB_ENV, `TAG_NAME=${releaseTag}\n`);
}
