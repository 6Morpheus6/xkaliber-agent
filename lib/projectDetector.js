const fs = require('fs');
const path = require('path');

function detect(projectRoot) {
    const out = {
        projectType: 'brownfield',
        testCmd: null,
        lintCmd: null,
        installCmd: null,
        language: 'unknown'
    };

    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
        out.language = 'node';
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.test) out.testCmd = 'npm test';
            if (pkg.scripts?.lint) out.lintCmd = 'npm run lint';
            out.installCmd = fs.existsSync(path.join(projectRoot, 'package-lock.json')) ? 'npm ci' : 'npm install';
        } catch (e) { /* skip */ }
    }

    if (fs.existsSync(path.join(projectRoot, 'pyproject.toml')) || fs.existsSync(path.join(projectRoot, 'pytest.ini'))) {
        out.language = 'python';
        if (!out.testCmd) out.testCmd = 'pytest -q';
        if (!out.lintCmd) out.lintCmd = 'python -m py_compile .';
    }

    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
        out.language = 'rust';
        out.testCmd = out.testCmd || 'cargo test';
    }

    if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
        out.language = 'go';
        out.testCmd = out.testCmd || 'go test ./...';
    }

    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) {
        try {
            const mk = fs.readFileSync(path.join(projectRoot, 'Makefile'), 'utf-8');
            if (!out.testCmd && /(^|\n)test:/.test(mk)) out.testCmd = 'make test';
        } catch (e) { /* skip */ }
    }

    const hasSource = fs.existsSync(pkgPath) ||
        fs.existsSync(path.join(projectRoot, 'src')) ||
        fs.existsSync(path.join(projectRoot, 'main.py'));
    if (!hasSource && !fs.existsSync(path.join(projectRoot, '.git'))) {
        out.projectType = 'greenfield';
    }

    return out;
}

module.exports = { detect };
