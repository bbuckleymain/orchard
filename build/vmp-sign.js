// Runs after electron-builder lays out the app, before it builds the installer.
// Widevine licence servers usually only accept Electron builds that castLabs has VMP-signed
// (Cider's Windows build is signed the same way), so a Windows build is signed here when castLabs'
// EVS tool is installed and signed in:
//   pip install --user castlabs-evs
//   python3 -m castlabs_evs.account signup     (or: reauth)
// Without it the build still succeeds, but protected playback may be refused on Windows.
const { execFileSync } = require("child_process");

exports.default = async function vmpSign(context) {
  if (!["win32", "darwin"].includes(context.electronPlatformName)) return;
  const python = process.platform === "win32" ? "python" : "python3";
  try {
    execFileSync(python, ["-m", "castlabs_evs.vmp", "sign-pkg", context.appOutDir], { stdio: "inherit" });
    console.log("  • VMP-signed", context.appOutDir);
  } catch {
    const msg = "VMP signing skipped: castlabs-evs isn't installed or signed in (see build/vmp-sign.js).";
    if (process.env.ORCHARD_REQUIRE_VMP) throw new Error(msg);
    console.warn("  ⚠ " + msg);
  }
};
