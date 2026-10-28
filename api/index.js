// Vercel serverless entry point: reuses the Express app from server.js.
// On Vercel, environment variables come from the project settings, not
// from the local .env file (which is gitignored for real values).
module.exports = require("../server.js");
