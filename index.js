// Copyright (C) 2011 - Texas Instruments, Jason Kridner
//
// Modified by Aditya Patadia, Octal Consulting LLP
var fs = require('fs');
var child_process = require('child_process');
var debug = require('debug')('bone');
var os = require('os');
var epoll = require('epoll');
var pinmap = require('./lib/pinmap');
var serial = require('./lib/serial');
var iic = require('./lib/iic');
var bone = require('./lib/bone');
var package_json = require('./package.json');
var g = require('./lib/constants');

var f = {};

// Keep track of allocated resources
var gpio = {};
var gpioInt = {};
var pwm = {};

// Detect if we are on a Beagle
var hw = null;

if(os.type() == 'Linux' && os.arch() == 'arm') {
    if(!bone.is_cape_universal()) {
        debug('Loading Universal Cape interface...');
        bone.create_dt_sync("OBS_UNIV");
        if(!bone.is_audio_enable()){
            debug('Loading AUDIO Cape...');
            bone.create_dt_sync("OBS_AUDIO");
        }
        if(!bone.is_hdmi_enable()){
            debug('Loading HDMI Cape...');
            bone.create_dt_sync("OBS_HDMI");
        }
    }
    debug('Using Universal Cape interface');
    hw = require('./lib/hw_universal');
    
    debug('Enabling analog inputs');
    hw.enableAIN();
} else {
    hw = require('./lib/hw_simulator');
    debug('Using simulator mode');
}


// returned object has:
//  mux: index of mux mode
//  options: array of mode names
//  slew: 'fast' or 'slow'
//  rx: 'enabled' or 'disabled'
//  pullup: 'diabled', 'pullup' or 'pulldown'
//  pin: key string for pin
//  name: pin name
//  pwm: object if pwm enabled, undefind otherwise
//    freq: frequency of PWM
//    value: duty cycle of PWM as number between 0 and 1
//  gpio: object if GPIO enabled, undefined otherwise
//    active: GPIO is enabled by the kernel
//    allocated: boolean for if it is allocated by this application
//    direction: 'in' or 'out' (allocated might be false)
f.getPinMode = function(pin, callback) {
    if(typeof callback != 'function') {
        throw new verror("getPinMode() requires callback function");
    }
    if(pin) {
        pin = bone.getpin(pin);
    } else {
        throw new verror("Please provide valid pin as first argument");
    }
    debug('getPinMode(' + pin.key + ')');
    var mode = {'pin': pin.key, 'name': pin.name};
    if(pin.options) mode.options = pin.options;

    // Get PWM settings if applicable
    if(
        (typeof pin.pwm != 'undefined') &&              // pin has PWM capabilities
        (typeof pwm[pin.pwm.name] != 'undefined') &&    // PWM used for this pin is enabled
        (pin.key == pwm[pin.pwm.name].key)              // PWM is allocated for this pin
    ) {
        hw.readPWMFreqAndValue(pin, pwm[pin.pwm.name], onReadPWM);
    } else {
        onReadPWM(null);
    }

    function onReadPWM(err, pwm){
        if(err) {
            console.error(err.message);
            callback(err, null);
            return;
        }
        if(pwm){
            mode.pwm = pwm;
        }
        // Get GPIO settings if applicable
        if((typeof pin.gpio != 'undefined')) {
            var n = pin.gpio;
            hw.readGPIODirection(n, onReadGPIODirection);
        } else {
            hw.readPinState(pin, onReadPinState);
        }
    }

    function onReadGPIODirection(err, direction){
        if(err){
            console.error(error.message);
            callback(err, null);
            return;
        }
        mode.gpio = direction;
        var n = pin.gpio;
        if(typeof gpio[n] == 'undefined') {
            mode.gpio.allocated = false;
        } else {
            mode.gpio.allocated = true;
        }
        hw.readPinState(pin, onReadPinState);
    }

    function onReadPinState(err, state){
        if(err){
            console.error(err.message);
            calback(err, null);
            return;
        }
        mode.pinState = state;
        callback(null, mode);
    }
};

f.pinMode = function(givenPin, mode, callback) {
    if(arguments.length > 3 || (callback && typeof callback != 'function')){
        console.error("As of version 0.4.0, pinMode function takes only 3 arguments (pin, mode, callback). " +
        "This function is now fully async so we recommend using callback to know completion of this funciton.");
        throw new verror("pinMode arguments are not valid.");
    }

    var pin = bone.getpin(givenPin);
    var n = pin.gpio;
    var direction;
    
    debug('pinMode(' + [pin.key, direction] + ');');

    if(mode == g.INPUT_PULLUP){
        mode = "gpio_pu";
        direction = g.INPUT;
    } else if(mode == g.INPUT_PULLDOWN){
        mode = "gpio_pd";
        direction = g.INPUT;
    } else if(mode == g.INPUT || mode == g.OUTPUT) {
        direction = mode;
        mode = "gpio";
    } else if(mode == g.ANALOG_OUTPUT) {
        if(typeof pin.pwm == 'undefined'){
            var err = new verror('BeagleBone does not ANALOG_OUTPUT for PWM pin: ' + pin.key);
            console.error(err.message);
            if(typeof callback == 'function') callback(err, null);
            return;
        }
        mode = "pwm";
        pwm[pin.pwm.name] = {'key': pin.key, 'freq': 0};
        direction = g.OUTPUT;
    } else {
        throw new verror('Invalid mode value provided to pinMode function.');
    }

    // Handle case where pin is allocated as a gpio-led
    if(pin.led) {
        if(direction != g.OUTPUT) {
            var err = new verror('pinMode only supports GPIO output for LED pin: ' + pin.key);
            console.error(err.message);
            if(typeof callback == 'function') callback(err, null);
            return;
        }

        hw.setLEDPinToGPIO(pin, resp, onSetLEDPin);

        return; // since nothing to do more for LED pins
    }

    function onSetLEDPin(err, resp){
        if(err) {
            console.error(err.message);
            if(typeof callback == 'function') callback(err, null);
        } else {
            gpio[n] = true;
            if(typeof callback == 'function') callback(null, givenPin);
        }
    }

    // May be required: mount -t debugfs none /sys/kernel/debug
    hw.setPinMode(pin, mode, onSetPinMode);
    
    function onSetPinMode(err) {
        debug('returned from setPinMode');
        if(err) {
            err = new verror(err, 'Unable to configure mux for pin ' + pin);
            console.error(err.message);
            // It might work if the pin is already muxed to desired mode
            if(callback) callback(err, null);
        } else {
            pinModeTestGPIO();
        }
    }
    
    function pinModeTestGPIO() {
        // Enable GPIO
        if(mode == "gpio" || mode == "gpio_pu" || mode == "gpio_pd") {
            // Export the GPIO controls
            resp = hw.exportGPIOControls(pin, direction, onExport);
        } else {
            delete gpio[n];
            if(callback) callback(null, givenPin);
        }
    }
    
    function onExport(err) {
        if(err) {
            console.error(err.message);
            delete gpio[n];
            if(callback) callback(err, null);
        } else {
            gpio[n] = true;
            if(callback) callback(null, givenPin);
        }
    }
};

f.digitalWrite = function(pin, value, callback) {
    if(pin) {
        pin = bone.getpin(pin);
    } else {
        throw new verror("Provide pin as first argument to digitalWrite");
    }
    debug('digitalWrite(' + [pin.key, value] + ');');
    value = parseInt(Number(value), 2) ? 1 : 0;

    if(typeof callback == 'undefined') {
        hw.writeGPIOValueSync(pin, value);
    } else {
        hw.writeGPIOValue(pin, value, callback);
    }
};


f.digitalRead = function(pin, callback) {
    if(typeof callback != 'function') {
        throw new verror("digitalRead() requires callback function");
    }
    pin = bone.getpin(pin);
    debug('digitalRead(' + [pin.key] + ');');

    if(typeof pin.ain != 'undefined') {
        f.analogRead(pin, analogCallback);
    } else {
        hw.readGPIOValue(pin, callback);
    }

    function analogCallback(err, resp) {
        if(err){
            console.error(err.message);
            callback(err, null);
        } else {
            resp = analogValue(resp);
            callback(null, resp);
        }
    }

    function analogValue(resp) {
        if(resp.value > 0.5) {
            resp.value = g.HIGH;
        } else {
            resp.value = g.LOW;
        }
        return resp;
    }
};


f.analogRead = function(pin, callback) {
    if(typeof callback != 'function') {
        throw new verror("analogRead() requires callback function");
    }
    pin = bone.getpin(pin);
    debug('analogRead(' + [pin.key] + ');');

    if(typeof pin.ain == 'undefined') {
        f.digitalRead(pin, callback);
    } else {
        hw.readAIN(pin, callback);
    }
};


f.stopAnalog = function(pin, callback){
    pin = bone.getpin(pin);
    if(typeof pin.pwm == 'undefined') {
        throw new verror( pin.key + ' does not support stopAnalog()');
    }
    // Enable PWM controls if not already done
    if(typeof pwm[pin.pwm.name] == 'undefined') {
        f.pinMode(pin, g.ANALOG_OUTPUT, onPinMode);
    } else {
        onPinMode();
    }

    function onPinMode() {
        hw.stopPWM(pin, pwm[pin.pwm.name],callback);
    }
};


f.startAnalog = function(pin, callback){
    pin = bone.getpin(pin);
    if(typeof pin.pwm == 'undefined') {
        throw new verror(pin.key + ' does not support startAnalog()');
    }
    // Enable PWM controls if not already done
    if(typeof pwm[pin.pwm.name] == 'undefined') {
        f.pinMode(pin, g.ANALOG_OUTPUT, onPinMode);
    } else {
        onPinMode();
    }

    function onPinMode() {
        hw.startPWM(pin, pwm[pin.pwm.name],callback);
    }
};


// See http://processors.wiki.ti.com/index.php/AM335x_PWM_Driver's_Guide
// That guide isn't useful for the new pwm_test interface
f.analogWrite = function(pin, value, freq, callback) {
    pin = bone.getpin(pin);
    debug('analogWrite(' + [pin.key, value, freq] + ');');
    freq = freq || 2000.0;
    var resp = {};

    // Make sure the pin has a PWM associated
    if(typeof pin.pwm == 'undefined') {
        throw new verror( pin.key + ' does not support analogWrite()';
    }

    // Make sure there is no one else who has the PWM
    if(
        (typeof pwm[pin.pwm.name] != 'undefined') &&    // PWM needed by this pin is already allocated
        (pin.key != pwm[pin.pwm.name].key)              // allocation is not by this pin
    ) {
        var err = 'analogWrite: ' + pin.key + ' requires pwm ' + pin.pwm.name +
            ' but it is already in use by ' + pwm[pin.pwm.name].key;
        err = new verror(err);
        console.error(err.message);
        if(typeof callback == 'function') callback(err);
        return;
    }

    // Enable PWM controls if not already done
    if(typeof pwm[pin.pwm.name] == 'undefined') {
        f.pinMode(pin, g.ANALOG_OUTPUT, onPinMode);
    } else {
        onPinMode();
    }

    function onPinMode() {
        // Perform update
        hw.writePWMFreqAndValue(pin, pwm[pin.pwm.name], freq, value, onWritePWM);
    }

    function onWritePWM(err){
        // Save off the freq, value and PWM assignment
        if(err) {
            err = new verror(err, "There was an error writing analog value");
            callback(err);
        } else {
            pwm[pin.pwm.name].freq = freq;
            pwm[pin.pwm.name].value = value;

            // All done
            if(callback) callback(null);
        }
    }
};


f.shiftOut = function(dataPin, clockPin, bitOrder, val, callback) {
    dataPin = bone.getpin(dataPin);
    clockPin = bone.getpin(clockPin);
    debug('shiftOut(' + [dataPin.key, clockPin.key, bitOrder, val] + ');');
    var i = 0;
    var bit;
    var clock = 0;
    next();

    function next(err) {
        debug('i = ' + i);
        debug('clock = ' + clock);
        if(err || i == 8) {
            if(callback) callback({'err': err});
            return;
        }
        if(bitOrder == g.LSBFIRST) {
            bit = val & (1 << i);
        } else {
            bit = val & (1 << (7 - i));
        }
        if(clock === 0) {
            clock = 1;
            if(bit) {
                f.digitalWrite(dataPin, g.HIGH, next);
            } else {
                f.digitalWrite(dataPin, g.LOW, next);
            }
        } else if(clock == 1) {
            clock = 2;
            f.digitalWrite(clockPin, g.HIGH, next);
        } else if(clock == 2) {
            i++;
            clock = 0;
            f.digitalWrite(clockPin, g.LOW, next);
        }
    }
};


f.attachInterrupt = function(pin, handler, mode, callback) {
    pin = bone.getpin(pin);
    debug('attachInterrupt(' + [pin.key, handler, mode] + ');');
    var n = pin.gpio;
    var err;

    /* Check if we don't have the required Epoll module
    if(!epoll.exists) {
        resp.err = 'attachInterrupt: requires Epoll module';
        console.error(resp.err);
        if(callback) callback(resp);
        return;
    }
    */

    // Check if pin isn't already configured as GPIO
    if(typeof gpio[n] == 'undefined') {
        err = new verror('attachInterrupt: pin ' + pin.key + ' not already configured as GPIO');
        console.error(err.message);
        if(callback) callback(err, null);
        return;
    }

    // Check if someone already has a handler configured
    if(typeof gpioInt[n] != 'undefined') {
        err = new verror('attachInterrupt: pin ' + pin.key + ' already has an interrupt handler assigned');
        console.error(err.message);
        if(callback) callback(err);
        return;
    }

    var intHandler = function(err, fd, events) {
        var m = {};
        if(err) {
            m.err = err;
        }
        fs.readSync(gpioInt[n].valuefd, gpioInt[n].value, 0, 1, 0);
        m.pin = pin;
        m.value = parseInt(Number(gpioInt[n].value), 2);
        if(typeof handler =='function') m.output = handler(m);
        else m.output = {handler:handler};
        if(m.output && (typeof callback == 'function')) callback(m);
    };

    try {
        gpioInt[n] = hw.writeGPIOEdge(pin, mode);
        gpioInt[n].epoll = new epoll.Epoll(intHandler);
        fs.readSync(gpioInt[n].valuefd, gpioInt[n].value, 0, 1, 0);
        gpioInt[n].epoll.add(gpioInt[n].valuefd, epoll.Epoll.EPOLLPRI);
        resp.attached = true;
    } catch(ex) {
        resp.err = 'attachInterrupt: GPIO input file not opened: ' + ex;
        console.error(resp.err);
    }
    if(callback) callback(resp);
    return;
};


f.detachInterrupt = function(pin, callback) {
    pin = bone.getpin(pin);
    debug('detachInterrupt(' + [pin.key] + ');');
    var n = pin.gpio;
    if(typeof gpio[n] == 'undefined' || typeof gpioInt[n] == 'undefined') {
        if(typeof callback == 'function') callback({'pin':pin, 'detached':false});
        return;
    }
    gpioInt[n].epoll.remove(gpioInt[n].valuefd);
    delete gpioInt[n];
    if(typeof callback == 'function') callback({'pin':pin, 'detached':true});
};


f.getEeproms = function(callback) {
    if(typeof callback == 'undefined') {
        console.error("getEeproms requires callback");
        return;
    }
    var eeproms = {};
    eeproms = hw.readEeproms(eeproms);
    if(eeproms == {}) {
        debug('No valid EEPROM contents found');
    }
    if(callback) callback(eeproms);
};


f.getPlatform = function(callback) {
    if(typeof callback == 'undefined') {
        throw new verror("getPlatform requires callback");
    }
    var platform = {
        'platform': pinmap,
        'name': "BeagleBone",
        'bonescript': package_json.version,
        'os': {}
    };
    platform.os.hostname = os.hostname();
    platform.os.type = os.type();
    platform.os.arch = os.arch();
    platform.os.release = os.release();
    platform.os.uptime = os.uptime();
    platform.os.loadavg = os.loadavg();
    platform.os.totalmem = os.totalmem();
    platform.os.freemem = os.freemem();
    platform.os.networkInterfaces = os.networkInterfaces();
    platform = hw.readPlatform(platform);
    if(callback) callback(null, platform);
};


f.setDate = function(date, callback) {
    child_process.exec('date -s "' + date + '"', dateResponse);
    
    function dateResponse(err, stdout, stderr) {
        if(err){
            err = new verror(err);
            if ( callback ) callback(err);
        } else {
            if ( callback ) callback(null, {'stdout':stdout, 'stderr':stderr});
        }
    }
};


f.startWatchdog = hw.startWatchdog;

f.stopWatchdog = hw.stopWatchdog;

// Exported variables
f.bone = pinmap; // this likely needs to be platform and be detected
for(var x in serial) {
    f[x] = serial[x];
}
for(var x in iic) {
    f[x] = iic[x];
}
for(var x in g) {
    f[x] = g[x];
}

module.exports = f;

debug('index.js loaded');
