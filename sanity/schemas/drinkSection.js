import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'drinkSection',
  title: 'Drink Menu Section',
  type: 'document',
  fields: [
    defineField({name: 'title', title: 'Section Title', type: 'string', placeholder: 'e.g. Cocktails, Wine, Beer', validation: Rule => Rule.required()}),
    defineField({name: 'order', title: 'Display Order', type: 'number'}),
    defineField({
      name: 'items',
      title: 'Drinks',
      type: 'array',
      of: [{
        type: 'object',
        fields: [
          {name: 'name', title: 'Name', type: 'string'},
          {name: 'description', title: 'Description', type: 'string'},
          {name: 'price', title: 'Price', type: 'string'},
          {name: 'available', title: 'Available', type: 'boolean', initialValue: true},
        ],
        preview: {select: {title: 'name', subtitle: 'price'}},
      }],
    }),
    defineField({name: 'active', title: 'Show on Website', type: 'boolean', initialValue: true}),
  ],
  preview: {
    select: {title: 'title', items: 'items'},
    prepare({title, items}) {
      return {title, subtitle: `${(items || []).length} drinks`}
    },
  },
})
