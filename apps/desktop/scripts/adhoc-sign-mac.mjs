// electron-builder afterPack hook: ad-hoc sign UNSIGNED macOS bundles.
//
// With mac.identity=null electron-builder skips code signing entirely. The
// repacked .app then keeps the linker signature of the Electron binary it was
// built from while carrying no _CodeSignature seal of its own, so its signature
// is not merely absent — it is INVALID ("code has no resources but signature
// indicates they must be present"). macOS reports a downloaded build in that
// state as "damaged and can't be opened", which offers the user no way through.
//
// An ad-hoc signature makes the bundle's own signature valid without any Apple
// credential. Gatekeeper still refuses to launch it unprompted (ad-hoc is not a
// Developer ID), but it now falls back to the ordinary unidentified-developer
// path, which the user can clear via Privacy & Security -> Open Anyway.
//
// Skipped when a real signing identity is configured: electron-builder signs
// those bundles itself, and overwriting a Developer ID signature with an ad-hoc
// one would silently destroy the release.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity !== null) return;

  if (process.platform !== "darwin") {
    throw new Error(
      "cannot ad-hoc sign a macOS bundle off macOS: codesign is unavailable, and the resulting app would be rejected as damaged",
    );
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // --deep is deprecated for real distribution signing (each nested binary
  // should be signed on its own), but it is the supported way to seal an entire
  // bundle ad-hoc in one pass, and an ad-hoc signature is never a distribution
  // signature anyway.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

  console.log(`  • ad-hoc signed (unsigned build) ${appPath}`);
}
