import {defineField, defineType} from 'sanity'

// Needed as standalone type for schema registration
export default defineType({
  name: 'menuItem',
  title: 'Menu Item',
  type: 'document',
  fields: [
    defineField({name: 'name', title: 'Name', type: 'string'}),
    defineField({name: 'price', title: 'Price', type: 'string'}),
  ],
})
