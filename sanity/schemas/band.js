import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'band',
  title: 'Band / Performance',
  type: 'document',
  fields: [
    defineField({name: 'name', title: 'Band / Artist Name', type: 'string', validation: Rule => Rule.required()}),
    defineField({name: 'date', title: 'Date', type: 'date', validation: Rule => Rule.required()}),
    defineField({name: 'time', title: 'Time', type: 'string', placeholder: 'e.g. 7 PM – 10 PM'}),
    defineField({name: 'notes', title: 'Notes (internal)', type: 'string'}),
    defineField({name: 'active', title: 'Show on Website', type: 'boolean', initialValue: true}),
  ],
  orderings: [{title: 'Date', name: 'dateAsc', by: [{field: 'date', direction: 'asc'}]}],
  preview: {
    select: {title: 'name', subtitle: 'date', time: 'time'},
    prepare({title, subtitle, time}) {
      const d = subtitle ? new Date(subtitle + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'}) : ''
      return {title, subtitle: `${d}${time ? ' · ' + time : ''}`}
    },
  },
})
