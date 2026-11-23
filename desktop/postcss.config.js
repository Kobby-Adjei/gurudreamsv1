// PostCSS pipeline for the renderer (Tailwind + Autoprefixer).
// The Tailwind config path is pinned so the build works from any cwd.
const path = require('node:path')

module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.ts') },
    autoprefixer: {}
  }
}
