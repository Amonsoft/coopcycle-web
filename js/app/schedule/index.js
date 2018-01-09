import 'fullcalendar'
import 'fullcalendar/dist/locale-all'

const $calendar = $('#calendar')

$calendar.fullCalendar({
  defaultView: 'agendaWeek',
  locale: 'fr',
  dayClick: (date, e, view, resource) => {
    console.log('dayClick', date.format('YYYY-MM-DD'))
    $calendar.fullCalendar('renderEvent', {
        title: 'Shift #1',
        editable: true,
        start: date.format(),
        end: date.add(2, 'hour').format(),
        allDay: false
    }, true)
  },
  eventClick: (event, e, view) => {
    console.log('eventClick', event)
    $('#event-modal').modal('show')
  },
  events: [
    {
        title: 'Shift #1',
        editable: true,
        start: '2018-01-09T12:30:00',
        end: '2018-01-09T16:30:00',
        allDay: false
    },
    {
        title: 'Shift #2',
        editable: true,
        start: '2018-01-10T09:30:00',
        end: '2018-01-10T12:30:00',
        allDay: false
    }
  ]
})
