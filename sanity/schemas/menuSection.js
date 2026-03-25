import {defineField, defineType} from 'sanity'

export const menuItem = defineType({
  name: 'menuItem',
  title: 'Menu Item',
  type: 'object',
  fields: [
    defineField({name: 'name', title: 'Item Name', type: 'string', validation: Rule => Rule.required()}),
    defineField({name: 'description', title: 'Description', type: 'string'}),
    defineField({name: 'price', title: 'Price', type: 'string', placeholder: 'e.g. $14.99 or $14.99 / $9.99'}),
    defineField({name: 'available', title: 'Available', type: 'boolean', initialValue: true}),
  ],
  preview: {
    select: {title: 'name', subtitle: 'price'},
  },
})

export default defineType({
  name: 'menuSection',
  title: 'Menu Section',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Section Title',
      type: 'string',
      placeholder: 'e.g. Shareables, Sandwiches & Wraps',
      validation: Rule => Rule.required(),
    }),
    defineField({
      name: 'order',
      title: 'Display Order',
      type: 'number',
      description: 'Lower numbers appear first (1 = top)',
    }),
    defineField({
      name: 'items',
      title: 'Menu Items',
      type: 'array',
      of: [{type: 'menuItem'}],
    }),
    defineField({name: 'active', title: 'Show on Website', type: 'boolean', initialValue: true}),
  ],
  orderings: [{title: 'Display Order', name: 'orderAsc', by: [{field: 'order', direction: 'asc'}]}],
  preview: {
    select: {title: 'title', items: 'items'},
    prepare({title, items}) {
      return {title, subtitle: `${(items || []).length} items`}
    },
  },
})
