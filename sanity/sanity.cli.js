// sanity.cli.js
import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: '4t94f56h',
    dataset: 'production',
  },
  // After deploying, set up a webhook in Sanity dashboard:
  // sanity.io/manage → your project → API → Webhooks
  // URL: your Netlify build hook URL
  // Filter: *[_type in ["event","band","menuSection","drinkSection","beerGarden","pressArticle","jobPosting","siteSettings"]]
  // This triggers a site rebuild every time you publish changes in Sanity
})
