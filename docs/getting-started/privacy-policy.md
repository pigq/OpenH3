# OpenH3 Privacy Policy

**Effective date: 2026-11-26**

OpenH3 is an open source desktop application for conversational work and local image and video workflows. This policy explains what the application may send when the relevant feature is enabled or when the user asks us to investigate a problem.

## Data handled by the application

OpenH3 stores application data, conversations, settings, generated files, and downloaded local model or workflow files on the user's device. Using remote models, agent tools, feedback, or diagnostics can transmit selected content or log information as described below; storing content locally does not guarantee it never leaves the device.

When the user uses a model provider or OpenH3 cloud account, the application sends the prompt, conversation context, selected model parameters, and attached media needed for that request to the configured provider or gateway. Agent tools, skills, extensions, and MCP servers can read files, run commands, or contact other services within their configured permissions. Their results can become model context. The receiving service's own privacy policy and retention terms apply. OpenH3 does not claim that a provider or gateway retains no data.

OpenH3 stores cloud-account session material in encrypted local application storage and uses it to authenticate account and model requests. Protect the device and its local application data; this statement is not a guarantee that every tool, provider, extension, log, or third-party component handles credentials identically.

## Diagnostics and feedback

A release built with a Sentry destination can automatically send crash and startup-failure diagnostics to the distributor's configured Sentry project. These reports can contain application version, platform and architecture, installation and startup state, error details, tags, and a persistent random installation identifier. A random identifier is pseudonymous, not a guarantee of anonymity. Network services can also observe ordinary connection metadata, including the IP address.

When Sentry is configured, the application automatically schedules a recent-log report after startup, limited to one attempt per 24 hours after a report is recorded. It selects logs from the most recent day that contains logs and caps the compressed attachment at 19 MiB. Log contents and error attachments can include local paths, diagnostic context, or task-related information. Size limits and selective error sanitization do not guarantee that all personal information or secrets are removed.

A user can explicitly send a feedback or diagnostic report. That report can include the user's description, selected screenshots, local logs, diagnostic database/schema information, route and module context, and the signed-in cloud-account email used for support follow-up. Review screenshots and the information being reported. Do not put API keys, passwords, private prompts, private media, or other secrets in public issues.

## Updates and downloads

The application can contact the configured GitHub Releases and Aliyun OSS update endpoints to check for and download release metadata and installers. Download requests include ordinary network metadata such as the IP address and user-agent handled by those services. The application verifies release metadata and installer hashes according to the release implementation.

Local H3 and ComfyUI setup can download runtimes, model files, workflow files, and node packages from the sources used by the installation plan, such as model repositories, package registries, or release mirrors. Those downloads are governed by the relevant source's terms and privacy policy. Local generation alone does not create an OpenH3 public-media submission; selecting remote tools, model services, or feedback can transmit media.

## Account and billing data

When a user uses an OpenH3 cloud account, the account service processes registration/login information supplied by the user, account and session identifiers, model requests, usage, balance, orders, and payment or top-up status needed to provide the service. Checkout opens the configured payment service; that service handles the payment information entered on its page. The gateway, payment provider, and upstream model providers can operate in different locations and have their own storage and retention obligations. This desktop policy does not set their retention periods or represent a separate operator's legal commitments.

## User choices

Users can select their provider and tool permissions, avoid sending feedback, sign out of cloud accounts, and remove local files or application data using normal operating-system controls. Self-built distributions can omit Sentry configuration. The inspected desktop version does not provide a general in-app switch that disables every automatic diagnostic path; this policy does not imply such a control exists. Signing out does not delete previously recorded server-side orders or usage, and uninstalling may preserve local application data. A user can stop a model task or local workflow from the application. None of these actions recalls information already sent.

## Security and retention

Local application data normally remains until removed by the user or application cleanup. Diagnostic and server-side retention depends on the receiving deployment and its configured policies; a diagnostic attachment's one-day log selection is not a one-day server retention guarantee. OpenH3 does not claim a universal deletion period or that it can delete another service's records. No system can guarantee absolute security.

## Contact

For source and product questions, use the public issue tracker: <https://github.com/pigq/OpenH3/issues>. Do not include passwords, API keys, private prompts, private media, or full personal paths in public issues.

This policy is maintained with the OpenH3 source repository. Changes to the data flows or configured services may require an updated policy.
