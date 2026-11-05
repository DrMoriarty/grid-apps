const fs = require('fs-extra');
const path = require('path');

const PLANEGCS = path.join('node_modules', '@salusoft89', 'planegcs', 'dist');

async function main() {
    console.log('copying planegcs dist files');

    await fs.ensureDir(path.join('src', 'void', 'solver', 'planegcs_dist'));
    await fs.ensureDir(path.join('src', 'void', 'solver', 'sketch'));

    await fs.copy(
        path.join(PLANEGCS, 'index.js'),
        path.join('src', 'void', 'solver', 'planegcs.js')
    );

    await fs.copy(
        path.join(PLANEGCS, 'planegcs_dist'),
        path.join('src', 'void', 'solver', 'planegcs_dist')
    );

    await fs.copy(
        path.join(PLANEGCS, 'sketch'),
        path.join('src', 'void', 'solver', 'sketch')
    );
}

main().catch(err => {
    console.error('Error', err);
    process.exit(1);
});
