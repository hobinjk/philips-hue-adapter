/**
 *
 * PhilipsHueAdapter - an adapter for controlling Philips Hue lights
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

var Adapter = require('../adapter');
var Device = require('../device');
var Property = require('../property');
var storage = require('node-persist');
var fetch = require('node-fetch');
var Color = require('color');

const THING_TYPE_ON_OFF_COLOR_LIGHT = 'onOffColorLight';
const KNOWN_BRIDGE_USERNAMES = 'PhilipsHueAdapter.knownBridgeUsernames';

/**
 * Property of a light bulb
 * Boolean on/off or numerical hue, sat(uration), or bri(ghtness)
 */
class PhilipsHueProperty extends Property {
  constructor(device, name, descr, value) {
    super(device, name, descr);
    this.setCachedValue(value);
  }

  /**
   * @param {boolean|number} value
   * @return {Promise} a promise which resolves to the updated value.
   */
  setValue(value) {
    return new Promise(resolve => {
      this.setCachedValue(value);
      resolve(this.value);
      this.device.notifyPropertyChanged(this);
    });
  }
}

/**
 * A Philips Hue light bulb
 */
class PhilipsHueDevice extends Device {
  /**
   * @param {PhilipsHueAdapter} adapter
   * @param {String} id - A globally unique identifier
   * @param {String} lightId - id of the light expected by the bridge API
   * @param {Object} light - the light API object
   */
  constructor(adapter, id, lightId, light) {
    super(adapter, id);

    this.lightId = lightId;
    this.name = light.name;

    this.type = THING_TYPE_ON_OFF_COLOR_LIGHT;
    this.properties.set('on',
      new PhilipsHueProperty(this, 'on', {type: 'boolean'}, light.state.on));

    let color = Color({
      h: light.state.hue / 65535 * 360,
      s: light.state.sat / 255 * 100,
      v: light.state.bri / 255 * 100
    }).hex();

    this.properties.set('color',
      new PhilipsHueProperty(this, 'color', {type: 'string'}, color));

    this.adapter.handleDeviceAdded(this);
  }

  /**
   * When a property changes notify the Adapter to communicate with the bridge
   * TODO: batch property changes to not spam the bridge
   * @param {PhilipsHueProperty} property
   */
  notifyPropertyChanged(property) {
    super.notifyPropertyChanged(property);
    let properties = null;
    switch (property.name) {
      case 'color': {
        let color = Color(this.properties.get('color').value);
        properties = {
          hue: Math.floor(color.hue() * 65535 / 360),
          sat: Math.floor(color.saturationv() * 255 / 100),
          bri: Math.floor(color.value() * 255 / 100)
        };
        break;
      }
      case 'on': {
        // We might be turning on after changing the color
        let color = Color(this.properties.get('color').value);
        properties = {
          on: this.properties.get('on').value,
          hue: Math.floor(color.hue() * 65535 / 360),
          sat: Math.floor(color.saturationv() * 255 / 100),
          bri: Math.floor(color.value() * 255 / 100)
        };
        break;
      }
      default:
        console.warn('Unknown property:', property.name);
        return;
    }
    if (!properties) {
      return;
    }
    this.adapter.sendProperties(this.lightId, properties);
  }
}

/**
 * Philips Hue Bridge Adapter
 * Instantiates one PhilipsHueDevice per light
 * Handles the username acquisition (pairing) process
 */
class PhilipsHueAdapter extends Adapter {
  constructor(adapterManager, bridgeId, bridgeIp) {
    super(adapterManager, 'philips-hue-' + bridgeId, 'philips-hue');

    this.username = null;
    this.bridgeId = bridgeId;
    this.bridgeIp = bridgeIp;
    this.pairing = false;
    this.pairingEnd = 0;
    this.lights = {};

    adapterManager.addAdapter(this);

    storage.init().then(() => {
      return storage.getItem(KNOWN_BRIDGE_USERNAMES);
    }).then(knownBridgeUsernames => {
      if (!knownBridgeUsernames) {
        return Promise.reject('no known bridges');
      }

      var username = knownBridgeUsernames[this.bridgeId];
      if (!username) {
        return Promise.reject('no known username');
      }
      this.username = username;
      this.discoverLights();
    }).catch(e => {
      console.error(e);
    });
  }

  /**
   * If we don't have a username try to acquire one from the bridge
   * @param {number} timeoutSeconds
   */
  startPairing(timeoutSeconds) {
    this.pairing = true;
    this.pairingEnd = Date.now() + timeoutSeconds * 1000;

    this.attemptPairing();
  }

  attemptPairing() {
    this.pair().then(username => {
      this.username = username;
      return this.discoverLights();
    }).then(() => {
      return storage.init();
    }).then(() => {
      return storage.getItem(KNOWN_BRIDGE_USERNAMES);
    }).then(knownBridgeUsernames => {
      if (!knownBridgeUsernames) {
        knownBridgeUsernames = {};
      }
      knownBridgeUsernames[this.bridgeId] = this.username;
      return storage.setItem(KNOWN_BRIDGE_USERNAMES, knownBridgeUsernames);
    }).catch(e => {
      console.error(e);
      if (this.pairing && Date.now() < this.pairingEnd) {
        // Attempt pairing again later
        setTimeout(this.attemptPairing.bind(this), 500);
      }
    });
  }

  /**
   * Perform a single attempt at pairing with a Hue hub
   * @return {Promise} Resolved with username if pairing succeeds
   */
  pair() {
    if (this.username) {
      return Promise.resolve(this.username);
    }

    return fetch('http://' + this.bridgeIp + '/api', {
      method: 'POST',
      body: '{"devicetype":"mozilla_gateway#PhilipsHueAdapter"}'
    }).then(replyRaw => {
      return replyRaw.json();
    }).then(reply => {
      if (reply.length === 0) {
        return Promise.reject('empty response from bridge');
      }

      var msg = reply[0];
      if (msg.error) {
        return Promise.reject(msg.error);
      }

      return msg.success.username;
    });
  }

  cancelPairing() {
    this.pairing = false;
  }

  /**
   * Discovers lights known to bridge, instantiating one PhilipsHueDevice per
   * light
   * @return {Promise}
   */
  discoverLights() {
    if (!this.username) {
      return Promise.reject('missing username');
    }

    return fetch('http://' + this.bridgeIp + '/api/' + this.username +
                 '/lights').then(res => {
      return res.json();
    }).then(lights => {
      // TODO(hobinjk): dynamically remove lights
      for (var lightId in lights) {
        if (this.lights[lightId]) {
          continue;
        }
        var light = lights[lightId];
        var id = 'philips-hue-' + this.bridgeId + '-' + lightId;
        this.lights[lightId] = new PhilipsHueDevice(this, id, lightId, light);
      }
    });
  }

  /**
   * Update the state of a light
   * @param {String} lightId - Id of light usually from 1-n
   * @param {{on: boolean, bri: number, hue: number, sat: number}}
   *        properties - Updated properties of light to be sent
   * @return {Promise}
   */
  sendProperties(lightId, properties) {
    var uri = 'http://' + this.bridgeIp + '/api/' + this.username +
              '/lights/' + lightId + '/state';
    return fetch(uri, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(properties)
    }).then(res => {
      return res.text();
    }).catch(e => {
      console.error(e);
    });
  }
}

module.exports = PhilipsHueAdapter;

