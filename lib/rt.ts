/**
 * File system and path helpers for runtime data (jobs/, models/, py/, branding/).
 *
 * The app reads and writes files at paths only known while it runs. When the build sees such calls on a plain
 * `import fs from "node:fs"`, it traces them by scanning the whole project folder: tens of thousands of model
 * and job files, and the build fails outright if any file there is locked. Taking the modules from
 * process.getBuiltinModule hides these calls from the build; at runtime they are the same modules.
 */
export const fs = process.getBuiltinModule("node:fs");
export const fsp = process.getBuiltinModule("node:fs/promises");
export const path = process.getBuiltinModule("node:path");
