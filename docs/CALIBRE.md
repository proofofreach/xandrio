# Calibre integration

Xandrio's Calibre interface-action plugin sends selected books or a full Calibre library into the signed-in Xandrio profile. It supports EPUB, AZW3, MOBI, PRC, AZW, and PDF. It also sends Calibre metadata and cover art.

## Install and connect

1. In Xandrio, open **Settings → Calibre** and download `Xandrio-Calibre.zip`.
2. In Calibre, open **Preferences → Plugins → Load plugin from file** and select the ZIP. Accept Calibre's third-party plugin warning, then restart Calibre.
3. In Xandrio, select **Pair Calibre**. The six-digit code is valid for ten minutes and can be used once.
4. In Calibre, select **Xandrio → Connect to Xandrio**. Enter the Xandrio address and pairing code.
5. Select books and use **Xandrio → Send selected books**, or use **Send entire library**.

The first full send checks Xandrio's inventory, skips unchanged books, and asks for confirmation before transfer. Later sends compare Calibre's stable library UUID, book UUID, and last-modified value. A changed record updates Xandrio's catalog metadata and cover without creating a duplicate or replacing the imported book contents. Xandrio does not delete books when they disappear from Calibre.

The plugin chooses one format in this order: EPUB, AZW3, MOBI, PRC, AZW, PDF. Xandrio rejects DRM-protected Kindle files. Unsupported or unreadable books appear in the completion report.

## Access and revocation

The pairing code becomes a random, revocable plugin token. Xandrio stores only a hash of that token. The token can read the Calibre import inventory and submit Calibre imports for one Xandrio profile; it cannot use the rest of the account API.

Use **Settings → Calibre → Revoke** to disable a computer. **Forget connection** in Calibre removes the local token but does not revoke a copied token, so use Xandrio's revoke action when a computer is lost or retired.

For a remote Xandrio server, use a private TLS URL such as a Tailscale HTTPS address. Plain HTTP is suitable only on a trusted local network because the plugin token and book contents travel to that address.

## Discovery and distribution

The built-in discovery path is **Xandrio Settings → Calibre → Download plugin**. The project also keeps the installable ZIP at `public/downloads/Xandrio-Calibre.zip`; rebuild it with `npm run build:calibre-plugin`.

For discovery inside Calibre's **Get new plugins** screen, publish a support thread in the MobileRead Calibre Plugins forum, attach the same ZIP to the first post, and ask the plugin-index moderator to add it to the index. Do not advertise in-app discovery until the index accepts the plugin. The package includes Calibre's required import-name marker and version metadata for that process.

References: [Calibre plugin development](https://manual.calibre-ebook.com/creating_plugins.html) and [MobileRead plugin index](https://www.mobileread.com/forums/showthread.php?t=118764).
