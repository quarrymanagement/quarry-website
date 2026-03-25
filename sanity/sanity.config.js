import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemas'

export default defineConfig({
  name: 'the-quarry',
  title: 'The Quarry — Admin',
  projectId: '4t94f56h',
  dataset: 'production',
  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('The Quarry')
          .items([
            S.listItem().title('🎉 Events').child(S.documentTypeList('event')),
            S.listItem().title('🎵 Band Schedule').child(S.documentTypeList('band')),
            S.listItem().title('🍽 Food Menu').child(S.documentTypeList('menuSection')),
            S.listItem().title('🍷 Drink Menu').child(S.documentTypeList('drinkSection')),
            S.listItem().title('🌿 Beer Garden').child(S.document().schemaType('beerGarden').documentId('beerGarden')),
            S.listItem().title('📰 Press & Media').child(S.documentTypeList('pressArticle')),
            S.listItem().title('💼 Careers').child(S.documentTypeList('jobPosting')),
            S.listItem().title('⚙️ Site Settings').child(S.document().schemaType('siteSettings').documentId('siteSettings')),
          ])
    }),
    visionTool(),
  ],
  schema: {types: schemaTypes},
})
