# Further macOS integrations

The current release contains Reminders, Mail and Calendar. These candidates are recommendations, not promises of implemented support.

| Priority | Integration | Useful capabilities and constraints |
|---|---|---|
| 1 | [Contacts](https://developer.apple.com/documentation/contacts) | Resolve people and email addresses; read/manage contacts and groups. Requires contact permission; contact notes have a separate entitlement. |
| 2 | Notes scripting | Search/read/create/update notes through the installed Notes app's account/folder/note scripting dictionary. Requires Automation permission; it is not a general NotesKit framework. |
| 3 | [Shortcuts CLI](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac) | List and run selected workflows with inputs/outputs. Interactive shortcuts can pause for input; restrict execution to explicitly connected workflows. |
| 4 | [Spotlight metadata](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/SpotlightQuery/Concepts/QueryingMetadata.html) | Search local indexed files and metadata through NSMetadataQuery. Results depend on indexing and filesystem permissions; Core Spotlight's app index is a different API. |
| 5 | [PhotoKit](https://developer.apple.com/documentation/photokit) | Browse assets/albums and retrieve photos, including iCloud-managed assets. Requires Photos permission; originals may need downloading. |
| 6 | [Vision OCR](https://developer.apple.com/documentation/vision/recognizing-text-in-images) and [PDFKit](https://developer.apple.com/documentation/pdfkit/pdfdocument/string) | Extract text from screenshots/scans/PDFs; Vision performs OCR on device. Keep file access explicitly scoped. |
| 7 | [MapKit](https://developer.apple.com/documentation/mapkit/mkdirections) | Routes and travel-time estimates for planning. Directions contact Apple's servers and should be requested for information shown to the user. |

Contacts is the strongest next addition because it complements Mail recipient selection and Calendar planning.
