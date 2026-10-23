# Official content trust

`trusted-keys.json` maps reviewed publisher key IDs to Ed25519 SPKI PEM public keys.
No key is configured until the repository owner provisions the publisher. The client
continues using builtin content and reports TRUST_UNCONFIGURED without making
network requests. Never generate a private key at runtime or bypass verification.
Keys are shipped in the application, never trusted from downloaded content.

Legacy bundled previews remain available offline. Their generated attribution is
explicitly marked for review: the publication builder rejects that marker until
the owner has supplied accurate author, source and license information.
