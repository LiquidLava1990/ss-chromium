/**
 * The public key in the manifest's `key`, from which Chromium derives the extension's ID, so every
 * unpacked build has the same one (`SELF_BUILT_EXTENSION_ID` in `@browsermcp/protocol`), which the
 * SS Chromium server accepts. Only the public key is in this repository. The Chrome Web Store build
 * (`pnpm --filter @browsermcp/extension zip:store`) omits `key`; the store assigns the same ID when
 * the first upload carries the matching private key, which the maintainer keeps outside the repository.
 */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA78b6O7pM+Fu4nbeMbJCBVRFbHyB95l+95gHmh/vUPl6TdlDF7QN9Ts+4Xe9M39VX0NKcsHxGvxMMTTN5ujgzk+SN/Rmj45fa4rbzsbFcHYzHOXpMsv3OhhpHN4UGCk/X+H5XDy19Htd6nPDGMnhbic7BBuUQ6rM4338yQ9v6Ljiq69XMirGp4MV53GMUpHPIipR7PJtZljjBepAaEzcMOKk3/+PNoAKblbcPY/JEBUvg1/V2ElPxSVOK536hpnv5+PATh3mqE/2M++2m2noILkimihuE5eMvhgDx3TluT6nkOZW7YTkNfHpatxxbufo41wANe0Pm0jSY51LXmg5RZQIDAQAB";
