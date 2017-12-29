var WebSocketServer = require('ws').Server;
var http = require('http');
var fs = require('fs');
var co = require('co')
var _ = require('lodash')
var winston = require('winston')

const Courier = require('../models/Courier')
const CourierPool = require('../models/CourierPool')
const DeliveryRegistry = require('../models/DeliveryRegistry')

let level = process.env.NODE_ENV === 'production' ? 'error' : 'info'
// level = 'debug'

const logger = winston.createLogger({
  level,
  transports: [
    new winston.transports.Console(),
  ]
})

var ROOT_DIR = __dirname + '/../../..';

console.log('---------------------');
console.log('- STARTING DISPATCH -');
console.log('---------------------');

console.log('NODE_ENV = ' + process.env.NODE_ENV);
console.log('PORT = ' + process.env.PORT);

const {
  metrics,
  redis,
  pub,
  sub,
  sequelize
} = require('./config')(ROOT_DIR)

const db = require('../Db')(sequelize);
const couriers = new CourierPool(redis)
const deliveries = new DeliveryRegistry(sequelize, redis)

const {
  addToDispatching,
  addToWaiting,
  findNearest,
  nextDelivery,
  onConnect,
  onUpdateCoordinates,
  preload,
  removeFromDispatching,
  removeFromWaiting,
  subscribe,
} = require('./api')(db, redis, pub, metrics, couriers, deliveries, logger)

preload()
  .then(() => {

    logger.info('Subscribing to Redis channels...');
    subscribe(sub)

    let delay = new Map()

    co(function* () {

      logger.info('Starting loop...')

      const distances = [500, 1000, 2000, 2500, 3000, 3500, 4000, 4500]

      while (true) {

        // This will block until there is a delivery in the queue
        let delivery = yield nextDelivery()

        // If the delivery has been delayed, skip
        // if (delay.has(delivery.id) && delay.get(delivery.id) > 0) {
        //   logger.debug(`Skipping delivery #${delivery.id}...`)
        //   delay.set(delivery.id, delay.get(delivery.id) - 1)
        //   yield new Promise(resolve => setTimeout(resolve, 1000))
        //   continue
        // }

        // Try distances in ascending order
        for (let i = 0; i < distances.length; i++) {

          let distance = distances[i]
          let courier = yield findNearest(delivery, distance)

          if (courier) {

            logger.debug(`Dispatching delivery #${delivery.id} to ${courier.username}`)

            courier.setDelivery(delivery.id)
            courier.setState(Courier.DISPATCHING)

            yield removeFromWaiting(delivery.id)
            yield addToDispatching(delivery.id)

            logger.info(`Sending WebSocket message to ${courier.username}`)

            courier.send({
              type: 'delivery',
              delivery: {
                id: delivery.id,
                originAddress: delivery.originAddress.position,
                deliveryAddress: delivery.deliveryAddress.position,
                order: {
                  id: delivery.order.id
                },
              }
            })

            // Break the loop to avoid checking other distances
            break;

          } else {
            if (distance === 4500) {
              logger.debug(`Max distance reached!`)
              delay.set(delivery.id, 10)
            }
          }

        }

        yield new Promise(resolve => setTimeout(resolve, 1000))

      }

    }).then(function (value) {
      console.log(value);
    }, function (err) {
      console.error(err.stack);
    });

  })

var server = http.createServer(function(request, response) {
    // process HTTP request. Since we're writing just WebSockets server
    // we don't have to implement anything.
});
server.listen(process.env.PORT || 8000, function() {});

var cert = fs.readFileSync(ROOT_DIR + '/var/jwt/public.pem');
var TokenVerifier = require('../TokenVerifier');
var tokenVerifier = new TokenVerifier(cert, db);

var wsServer = new WebSocketServer({
    server: server,
    verifyClient: function (info, cb) {
      tokenVerifier.verify(info, cb);
    },
});

var isClosing = false;

// WebSocket server
wsServer.on('connection', function(ws) {

    const { user } = ws.upgradeReq;

    let state = Courier.UNKNOWN;

    db.Delivery.findOne({
      where: {
        status: {$in: ['DISPATCHED', 'PICKED']},
        courier_id: user.id
      }
    }).then(function(delivery) {

      if (delivery) {
        state = Courier.DELIVERING;
        logger.debug('Courier #' + user.username + ' was delivering #' + delivery.id);
      } else {
        logger.debug('Courier #' + user.username + ' was not delivering anything');
      }

      logger.info('Courier #' + user.username + ', setting state = ' + state);

      const data = user.toJSON()
      const courier = new Courier({ ...data, state })

      onConnect(courier, ws)

      ws.on('message', function(messageText) {

        if (isClosing) {
          return
        }

        var message = JSON.parse(messageText)
        if (message.type === 'updateCoordinates') {
          onUpdateCoordinates(courier, message.coordinates)
        }

      })

      ws.on('close', function() {

        couriers.remove(courier);

        logger.info('Courier #' + courier.username + ' disconnected!');
        logger.debug('Number of couriers connected: ' + couriers.size());

        metrics.gauge('couriers.connected', couriers.size())
        pub.prefixedPublish('offline', courier.username)

      })

    })

})

// Handle restarts
process.on('SIGINT', function () {

  console.log('---------------------');
  console.log('- STOPPING DISPATCH -');
  console.log('---------------------');

  isClosing = true;

  couriers.forEach(function(courier) {
    pub.prefixedPublish('offline', courier.username)
  })
  couriers.removeAll();
});
