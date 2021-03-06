// Copyright 2013 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['./values', './events', './database', './network', './maps', './widget', './audio', './sections'], function (values, events, database, network, maps, widget, audio, sections) {
  'use strict';
  
  var any = values.any;
  var LocalCell = values.LocalCell;
  var StorageNamespace = values.StorageNamespace;
  var StorageCell = values.StorageCell;
  
  function stubBlock(obj) {
    obj._reshapeNotice = new events.Neverfier();
    return obj;
  }
  
  var scheduler = new events.Scheduler();
  
  var freqDB = new database.Union();
  freqDB.add(database.allSystematic);
  freqDB.add(database.fromCatalog('dbs/')); // TODO get url from server
  // kludge till we have proper UI for selection of write targets
  var writableDB = database.fromURL('wdb/');
  freqDB.add(writableDB);
  
  var clientStateStorage = new StorageNamespace(localStorage, 'shinysdr.client.');
  function cc(key, type, value) {
    var cell = new StorageCell(clientStateStorage, type, key);
    if (cell.get() === null) {
      cell.set(value);
    }
    return cell;
  }
  var clientState = stubBlock({
    opengl: cc('opengl', Boolean, true),
    opengl_float: cc('opengl_float', Boolean, true),
    spectrum_split: cc('spectrum_split', new values.Range([[0, 1]], false, false), 0.5)
  });
  var clientBlockCell = new LocalCell(values.block, clientState);
  
  // TODO get url from server
  network.externalGet('/client/plugin-index.json', 'text', function gotPluginIndex(jsonstr) {
    var names = Array.prototype.slice.call(JSON.parse(jsonstr));
    requirejs(names, function (plugins) {
      connectRadio();
    });
  });
  
  function connectRadio() {
    var radio;
    network.connect('radio', scheduler, function gotDesc(remote, remoteCell) {
      // TODO always use remoteCell or change network.connect so radio is reshaped not replaced
      radio = remote;
      
      // Takes center freq as parameter so it can be used on hypotheticals and so on.
      function frequencyInRange(candidate, centerFreq) {
        var halfBandwidth = radio.input_rate.get() / 2;
        if (candidate < halfBandwidth && centerFreq === 0) {
          // recognize tuning for 0Hz gimmick
          return true;
        }
        var fromCenter = Math.abs(candidate - centerFreq) / halfBandwidth;
        return fromCenter > 0.01 && // DC peak
               fromCenter < 0.85;  // loss at edges
      }

      // Options
      //   receiver: optional receiver
      //   alwaysCreate: optional boolean (false)
      //   freq: float Hz
      //   mode: optional string
      //   moveCenter: optional boolean (false)
      function tune(options) {
        var alwaysCreate = options.alwaysCreate;
        var record = options.record;
        var freq = +options.freq || (record && record.freq);
        var mode = options.mode || (record && record.mode);
        var receiver = options.receiver;
        //console.log('tune', alwaysCreate, freq, mode, receiver);
      
        var receivers = radio.receivers.get();
        var fit = Infinity;
        if (!receiver && !alwaysCreate) {
          // Search for nearest matching receiver
          for (var recKey in receivers) {
            var candidate = receivers[recKey].get();
            if (!candidate.rec_freq) continue;  // sanity check
            if (mode && candidate.mode.get() !== mode) {
              // Don't use a different mode
              continue;
            }
            var thisFit = Math.abs(candidate.rec_freq.get() - freq);
            if (thisFit < fit) {
              fit = thisFit;
              receiver = candidate;
            }
          }
        }
      
        if (receiver) {
          receiver.rec_freq.set(freq);
          if (mode && receiver.mode.get() !== mode) {
            receiver.mode.set(mode);
          }
        } else {
          // TODO less ambiguous-naming api
          receivers.create({
            mode: mode || 'AM',
            rec_freq: freq
          });
          // TODO: should return stub for receiver or have a callback or something
        }
        
        var source = radio.source.get();
        if (options.moveCenter && !frequencyInRange(freq, source.freq.get())) {
          if (freq < radio.input_rate.get() / 2) {
            // recognize tuning for 0Hz gimmick
            source.freq.set(0);
          } else {
            // left side, just inside of frequencyInRange's test
            source.freq.set(freq + radio.input_rate.get() * 0.374);
          }
        }
      
        return receiver;
      }
      Object.defineProperty(radio, 'tune', {
        value: tune,
        configurable: true,
        enumerable: false
      });
    
      // Kludge to let frequency preset widgets do their thing
      // TODO(kpreid): Make this explicitly client state instead
      radio.preset = new LocalCell(any, undefined);
      radio.preset.set = function(freqRecord) {
        LocalCell.prototype.set.call(this, freqRecord);
        tune({
          record: freqRecord,
          moveCenter: true
        });
      };
    
      radio.targetDB = writableDB; // kludge reference
  
      var context = new widget.Context({
        // TODO all of this should be narrowed down, read-only, replaced with other means to get it to the widgets that need it, etc.
        radio: radio,
        clientState: clientState,
        spectrumView: null,
        freqDB: freqDB,
        scheduler: scheduler
      });
      
      var everything = new LocalCell(values.block, stubBlock({
        client: clientBlockCell,
        radio: remoteCell
      }));
      
      // generic control UI widget tree
      widget.createWidgets(everything, context, document);
      
      // Map (all geographic data)
      var map = new maps.Map(document.getElementById('map'), scheduler, freqDB, radio);
      
      // globals for debugging / interactive programming purposes only
      window.DfreqDB = freqDB;
      window.DwritableDB = writableDB;
      window.Dradio = radio;
    }); // end gotDesc
  
    audio.connectAudio('/audio');  // TODO get url from server
  }
});