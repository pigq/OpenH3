# Official content trust

`trusted-keys.json` maps reviewed publisher key IDs to Ed25519 SPKI PEM public keys.
The production public key `openh3-content-20261024` is configured and shipped with
the application. Its SPKI DER SHA256 is
`1decb9f5ca9eac04dc41c3509dd78e22ea5c7e3ee51ce86064f486607f9cbf41`.
Only public keys belong in this directory; never generate a private key at runtime
or trust keys downloaded with content.

`sourceConfigured` indicates trusted keys are present, not that a remote catalog
has been published or its media approved. Editorial redistribution rights and
publication approvals are not ready; this change does not publish remote content.
An unpublished/unavailable channel or failed verification keeps builtin content
or the last verified cache active, never unsigned content. An empty keyring still
reports TRUST_UNCONFIGURED without making network requests.

Legacy bundled previews remain available offline. Their generated attribution is
explicitly marked for review: the publication builder rejects that marker until
the owner has supplied accurate author, source and license information. A signing
key is not publication approval; do not substitute placeholder rights or approvals.
