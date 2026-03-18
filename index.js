const fs = require('fs');
const path = require('path');
const os = require('os');
async function getSDK() {
    // If not running in pkg, just return the standard require
    if (!process.pkg) {
        console.log("Running in normal Node.js environment.");
        return require('@pinggy/pinggy');
    }
    console.log("Running in packaged mode (pkg detected).");

    const tempDir = path.join(os.tmpdir(), 'pinggy-sdk-cache');
        const itemsToExtract = [
        { 
            src: path.join(__dirname, 'node_modules/@pinggy/pinggy'), 
            dest: path.join(tempDir) 
        },
        { 
            src: path.join(__dirname, 'node_modules/uuid'), 
            dest: path.join(tempDir, 'node_modules/uuid') 
        }
    ];

    // 1. Extract everything
    for (const item of itemsToExtract) {
        if (fs.existsSync(item.src)) {
            extractFolder(item.src, item.dest);
        }
    }

    // 2. Point the OS to the extracted .so library
    process.env.LD_LIBRARY_PATH = `${path.join(tempDir, 'lib')}:${process.env.LD_LIBRARY_PATH || ''}`;

    // 3. Require the SDK from the REAL filesystem (tempDir)
    // We use a dynamic path so pkg doesn't try to bundle this specific require
    return require(path.join(tempDir, 'dist', 'index.cjs'));
}

function extractFolder(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            extractFolder(srcPath, destPath);
        } else {
            // Avoid re-writing if file exists (performance)
            if (!fs.existsSync(destPath)) {
                fs.writeFileSync(destPath, fs.readFileSync(srcPath));
                // Set executable permissions for Linux
                if (entry.name.endsWith('.node') || entry.name.endsWith('.so') || entry.name.includes('worker')) {
                    fs.chmodSync(destPath, 0o755);
                }
            }
        }
    }
}


const { Worker } = require('worker_threads');
async function main(params) {
    try {
        const args = process.argv.slice(1);

        if (args[1] === "--version") {
            const pkgPath = path.join(__dirname, "package.json");
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            console.log(pkg.version);
            return;
        }

        const { pinggy, LogLevel } = await getSDK();
        console.log("Dirname", __dirname);
        console.log("Starting tunnel", args[1]);
        const tunnelOptions = {
            forwarding: `localhost:${args[1]}`,
            webDebugger: "localhost:8100",
        }

        const tunnel = await pinggy.createTunnel(tunnelOptions);
        await tunnel.start();
        console.log("Tunnel URLs:", await tunnel.urls());
        const keepAlive = setInterval(() => {}, 1000);

        process.on('SIGINT', async () => {
            console.log("\nStopping tunnel...");
            await tunnel.stop();
            clearInterval(keepAlive);
            process.exit(0);
        });
        //Stop tunnel after 20 seconds
        setTimeout(() => {
            try {
                console.log("Stopping tunnel...");
                tunnel.stop();
                console.log("Tunnel cleanly closed.");
            } catch (err) {
                console.error("Failed to close tunnel:", err);
            }
        }, 40000);
        console.log("Args: ", args)
    }
    catch (err) {
        console.error("Error starting tunnel:", err);
    }
}

main()