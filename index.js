
const fs = require('fs');
const path = require('path');
const os = require('os');

// Path where the addon will be "unpacked"
const tempDir = path.join(os.tmpdir(), 'pinggy-cli-cache');

function prepareNativeAddon() {
    if (__dirname.includes(path.sep + 'snapshot' + path.sep)) {
        console.log('App is running in packaged mode (snapshot filesystem detected).');
    } else {
        console.log('App is running in normal Node.js environment (real filesystem).');
    }
    console.log(process.env.PKG_NATIVE_CACHE_PATH);
    if (!process.pkg) {
        // running normally
        console.log("Not running in pkg, skipping addon extraction.");
        return;
    } // Do nothing if running in normal node

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // This path must match the internal path in your pkg config
    const internalLibPath = path.join(__dirname, 'node_modules/@pinggy/pinggy/lib');
    console.log(fs.readdirSync(path.join(__dirname, 'node_modules/@pinggy/pinggy/')));
    console.log("Internal Path:", internalLibPath, " Temp Dir:", tempDir);
    if (fs.existsSync(internalLibPath)) {
        const files = fs.readdirSync(internalLibPath);
        files.forEach(file => {
            const src = path.join(internalLibPath, file);
            console.log("Extracting", src, "to", tempDir);
            const dest = path.join(tempDir, file);

            // Only copy if it doesn't exist or you want to overwrite
            if (!fs.existsSync(dest)) {
                fs.writeFileSync(dest, fs.readFileSync(src));
                // On Linux/Mac, we must ensure the extracted files are executable
                if (process.platform !== 'win32') {
                    fs.chmodSync(dest, 0o755);
                }
            }
        });
    }
}

prepareNativeAddon();
const { pinggy, LogLevel } = require('@pinggy/pinggy');
async function main(params) {
    try {
        const args = process.argv.slice(1);
        //pinggy.setDebugLogging(true, LogLevel.DEBUG);
        console.log("Starting tunne", args[2]);
        const tunnelOptions = {
            forwarding: `localhost:${args[2]}`,
            webDebugger: "localhost:8100",
        }

        const tunnel = await pinggy.createTunnel(tunnelOptions);
        await tunnel.start();
        console.log("Tunnel URLs:", await tunnel.urls());
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