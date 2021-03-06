var websocket    = require('websocket-stream'),
    Frame        = require('canvas-to-buffer'),
    util         = require('util'),

    EventEmitter    = require('./../../util/eventEmitter'),
    Browser         = require('./../../util/browser'),
    Humanize        = require('./../../util/humanize'),
    UserMedia       = require('./../../util/userMedia'),
    VideomailError  = require('./../../util/videomailError')

var Recorder = function(visuals, replay, options) {

    EventEmitter.call(this, options, 'Recorder')

    // validate some options this class needs
    if (!options.video.fps)     throw new Error('FPS must be defined')
    if (!options.video.width)   throw new Error('Video width is too small')
    if (!options.video.height)  throw new Error('Video height is too small')

    var self            = this,
        browser         = new Browser(options.fakeUaString),

        wantedInterval  = 1e3 / options.video.fps,
        debug           = options.debug,

        recorderElement,
        userMedia,

        lastAnimationTimestamp,
        userMediaTimeout,

        intervalSum,
        bytesSum,
        framesCount,

        frameProgress,
        sampleProgress,

        canvas,
        ctx,
        rafId,

        samplesCount,
        framesCount,
        avgFps,
        submitting,
        unloaded,
        stopTime,
        stream,
        connected,
        key

    function onAudioSample(audioSample) {
        samplesCount++
        stream.write(audioSample.toBuffer())
    }

    function onUserMediaReady() {
        debug('Recorder: onUserMediaReady()')

        samplesCount = framesCount = 0
        submitting   = false

        show()
        self.emit('ready')
    }

    function clearUserMediaTimeout() {
        userMediaTimeout && clearTimeout(userMediaTimeout)
        userMediaTimeout = null
    }

    function loadUserMedia() {
        debug('Recorder: loadUserMedia()')

        try {
            userMediaTimeout = setTimeout(function() {
                if (!self.isReady())
                    self.emit('error', browser.getNoAccessIssue())
            }, options.timeouts.userMedia)

            navigator.getUserMedia({
                video: true,
                audio: options.audio.enabled
            }, function(localStream) {

                clearUserMediaTimeout()

                userMedia.init(
                    localStream,
                    onUserMediaReady.bind(self),
                    onAudioSample.bind(self),
                    function(err) {
                        self.emit('error', err)
                    }
                )

            }, function(err) {
                clearUserMediaTimeout()

                var errorListeners = self.listeners('error')

                if (errorListeners) {
                    self.emit('error', err)

                    setTimeout(function() {
                        loadUserMedia() // try again
                    }, options.timeouts.userMedia)
                } else {
                    debug('Recorder: no error listeners attached but throwing', err)

                    // weird situation, throw it since there are no error listeners yet
                    throw err
                }
            })

        } catch (exc) {
            this.emit('error', exc)
        }
    }

    function preview(args) {
        key = args.key

        if (args.mp4)
            replay.setMp4Source(args.mp4 + options.SITE_NAME_LABEL + '/' + options.siteName)

        if (args.webm)
            replay.setWebMSource(args.webm + options.SITE_NAME_LABEL + '/' + options.siteName)

        self.hide()
        self.emit('preview', args.key)

        if (options.debug) {
            var waitingTime = Date.now() - stopTime

            debug(
                'While recording, %s have been transferred and waiting time was %s',
                Humanize.filesize(bytesSum, 2),
                Humanize.toTime(waitingTime)
            )
        }
    }

    function updateFrameProgress(args) {
        frameProgress = ((args.frame / framesCount) * 100).toFixed(2) + '%'
        updateOverallProgress()
    }

    function updateSampleProgress(args) {
        sampleProgress = ((args.sample / samplesCount) * 100).toFixed(2) + '%'
        updateOverallProgress()
    }

    function updateOverallProgress() {
        self.emit('progress', frameProgress, sampleProgress)
    }

    function executeCommand(data) {

        var command,
            result

        try {
            command = JSON.parse(data.toString())
        } catch(ex) {
            throw ex
        }

        debug('Server says: %s', command.command, command.args, result ? '= ' + result : result)

        switch (command.command) {
            case 'ready':
                loadUserMedia()
                break
            case 'preview':
                preview(command.args)
                break
            case 'error':
                this.emit('error', new VideomailError('Oh f**k, server error!', {
                    explanation: command.args.err || '(No explanation given)'
                }))
                break
            case 'confirmFrame':
                result = updateFrameProgress(command.args)
                break
            case 'confirmSample':
                result = updateSampleProgress(command.args)
                break
            case 'beginAudioEncoding':
                this.emit('beginAudioEncoding')
                break
            case 'beginVideoEncoding':
                this.emit('beginVideoEncoding')
                break
            default:
                this.emit('error', 'Unknown server command: ' + command.command)
                break
        }
    }

    function writeCommand(command, args) {
        if (!connected) {
            debug('Trying to reconnect for the command', commmand, '…')

            initSocket(function() {
                debug('Reconnected')
                writeCommand(command, args)
            })
        } else if (stream) {
            debug('$ %s', command, args)

            var command = {
                command:    command,
                args:       args
            }

            stream.write(new Buffer(JSON.stringify(command)))
        }
    }

    function isNotifying() {
        return visuals.isNotifying()
    }

    function initSocket(cb) {
        if (!connected && !unloaded) {

            debug('Recorder: initialising web socket to %s', options.socketUrl)

            // https://github.com/maxogden/websocket-stream#binary-sockets

            // we use query parameters here because we cannot set custom headers in web sockets,
            // see https://github.com/websockets/ws/issues/467
            stream = websocket(
                options.socketUrl +
                '?' +
                encodeURIComponent(options.SITE_NAME_LABEL) +
                '=' +
                encodeURIComponent(options.siteName)
            )

            /*
            // useful for debugging streams

            if (!stream.originalEmit)
                stream.originalEmit = stream.emit

            stream.emit = function(type) {
                debug(type)
                var args = [].splice.call(arguments, 0)
                return stream.originalEmit.apply(stream, args)
            }
            */

            stream.on('error', function(err) {
                // workaround for bug https://github.com/maxogden/websocket-stream/issues/50

                if (stream && stream.destroyed) {

                    // Emit error first before unloading, because
                    // unloading will remove event listeners.
                    self.emit('error', new VideomailError('Unable to connect', {
                        explanation: 'A websocket connection has been refused. Either the server is in trouble or you are already connected in another instance?'
                    }))

                    self.unload(err)
                } else {

                    // ignore error if there is no stream, see race condition at
                    // https://github.com/maxogden/websocket-stream/issues/58#issuecomment-69711544

                    if (stream)
                        self.emit('error', err ? err : 'Unhandled websocket error')
                }
            })

            stream.on('end', function() {
                connected = false

                self.emit('ended')

                // do not attempt to reconnect when replay is shown
                if (!visuals.isReplayShown())
                    options.reconnect && setTimeout(function() {
                        initSocket(function() {
                            self.emit('reconnected')
                        })
                    }, 2e3)
            })

            var checkConnection = function() {
                if (!connected) {
                    connected = true

                    self.emit('connected')

                    cb && cb()
                }
            }

            stream.on('readable', checkConnection)
            stream.on('resume',   checkConnection)

            stream.on('data', function(data) {
                executeCommand.call(self, data)
            })
        } else
            debug('Not going to initialize socket.')
    }

    this.getAvgFps = function() {
        return avgFps
    }

    this.getKey = function() {
        return key
    }

    this.getAudioSampleRate = function() {
        return userMedia.getAudioSampleRate()
    }

    this.stop = function(limitReached) {
        debug('stop()')

        this.emit('stopping', limitReached)

        this.reset()

        stopTime = Date.now()

        avgFps = 1000 / (intervalSum / framesCount)

        var args = {
            framesCount:  framesCount,
            videoType:    replay.getVideoType(),
            avgFps:       avgFps
        }

        if (options.audio.enabled) {
            args.samplesCount = samplesCount
            args.sampleRate   = userMedia.getAudioSampleRate()
        }

        writeCommand('stop', args)
    }

    this.back = function() {
        show()
        this.reset()

        writeCommand('back')
    }

    this.unload = function(e) {
        var cause

        if (e)
            cause = e.name || e.statusText || e.toString()

        debug('Recorder: unload()', cause)

        this.removeAllListeners()
        this.reset()

        clearUserMediaTimeout()

        if (submitting)
            // server will disconnect socket automatically after submitting
            connected = false

        else if (stream) {
            // force to disconnect socket right now to clean temp files on server
            stream.end()
            stream = undefined
        }

        unloaded = true
    }

    this.reset = function() {
        debug('Recorder: reset()')

        this.emit('resetting')

        rafId && window.cancelAnimationFrame && window.cancelAnimationFrame(rafId)

        rafId = null

        replay.reset()

        // important to free memory
        userMedia && userMedia.stop()

        key = avgFps = canvas = ctx = sampleProgress = frameProgress = null
    }

    this.validate = function() {
        return connected && framesCount > 0 && canvas === null
    }

    this.isReady = function() {
        return userMedia.isReady()
    }

    this.pause = function(e) {
        debug('pause()', e)

        userMedia.pause()

        this.emit('paused')
    }

    this.isPaused = function() {
        return userMedia.isPaused()
    }

    this.resume = function() {
        debug('Recorder: resume()')

        this.emit('resuming')

        lastAnimationTimestamp = Date.now()
        userMedia.resume()
    }

    this.record = function() {

        if (unloaded)
            return false

        debug('Recorder: record()')

        this.emit('recording')

        canvas = userMedia.createCanvas()
        ctx    = canvas.getContext('2d')

        bytesSum = intervalSum = 0
        lastAnimationTimestamp = Date.now()

        var intervalThreshold = wantedInterval * .85, // allow 15% below fps (can't be too strict)
            frame             = new Frame(canvas, options),

            interval,
            now,
            buffer

        function calcInterval(now) {
            return now - lastAnimationTimestamp
        }

        function draw() {
            rafId = window.requestAnimationFrame(draw)

            if (!self.isPaused()) {

                now      = Date.now()
                interval = calcInterval(now)

                if (interval > intervalThreshold) {

                    // see: http://codetheory.in/controlling-the-frame-rate-with-requestanimationframe/
                    lastAnimationTimestamp = now - (interval % intervalThreshold)

                    intervalSum += interval

                    // ctx might become null when unloading
                    ctx && ctx.drawImage(userMedia.getRawVisuals(), 0, 0, canvas.width, canvas.height)

                    framesCount++

                    buffer = frame.toBuffer()

                    // stream might become null while unloading
                    stream && stream.write(buffer)

                    bytesSum += buffer.length

                    /*
                    if (options.debug) {
                        debug(
                            'Frame #' + framesCount + ' (' + buffer.length + ' bytes):',
                            interval + '/' + intervalThreshold + '/' + wantedInterval
                        )
                    }
                    */
                }
            }
        }

        userMedia.recordAudio()

        rafId = window.requestAnimationFrame(draw)
    }

    function buildElement() {
        recorderElement =  document.createElement('VIDEO')
        recorderElement.classList.add(options.selectors.userMediaClass)

        visuals.appendChild(recorderElement)
    }

    function show() {
        recorderElement.classList.remove('hide')
    }

    function initEvents() {
        self.on('submitting', function() {
            submitting = true
        })

        self.on('submitted', function() {
            submitting = false
        })
    }

    this.build = function(cb) {
        var err = browser.checkRecordingCapabilities()

        if (!err)
            err = browser.checkBufferTypes()

        if (err)
            cb(err)

        else {
            recorderElement = visuals.querySelector('video.' + options.selectors.userMediaClass)

            if (!recorderElement)
                buildElement()

            if (!recorderElement.width && options.video.width)
                recorderElement.width = options.video.width

            if (!recorderElement.height && options.video.height)
                recorderElement.height = options.video.height

            userMedia = new UserMedia(recorderElement, options)

            initEvents()
            initSocket()

            cb()
        }
    }

    this.isPaused = function() {
        return userMedia.isPaused()
    }

    this.isRecording = function() {
        return !!rafId && !this.isPaused() && !isNotifying()
    }

    this.hide = function() {
        recorderElement && recorderElement.classList.add('hide')
    }
}

util.inherits(Recorder, EventEmitter)

module.exports = Recorder
