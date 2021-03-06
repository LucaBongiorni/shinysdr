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

'use strict';

describe('values', function () {
  // TODO: duplicated code w/ other tests; move to a common library somewhere
  var s;
  beforeEach(function () {
    s = new shinysdr.events.Scheduler(window);
  });
  function createListenerSpy() {
    var l = jasmine.createSpy();
    l.scheduler = s;
    return l;
  }
  function expectNotification(l) {
    // TODO: we could make a timeless test by mocking the scheduler
    waitsFor(function() {
      return l.calls.length;
    }, 'notification received', 100);
    runs(function() {
      expect(l).toHaveBeenCalledWith();
    });
  }

  describe('Range', function () {
    var Range = shinysdr.values.Range;
    function frange(subranges) {
      return new Range(subranges, false, false);
    }
    it('should round at the ends of simple ranges', function () {
      expect(frange([[1, 3]]).round(0, -1)).toBe(1);
      expect(frange([[1, 3]]).round(2, -1)).toBe(2);
      expect(frange([[1, 3]]).round(4, -1)).toBe(3);
      expect(frange([[1, 3]]).round(0, 1)).toBe(1);
      expect(frange([[1, 3]]).round(2, 1)).toBe(2);
      expect(frange([[1, 3]]).round(4, 1)).toBe(3);
    });
    it('should round in the gaps of split ranges', function () {
      expect(frange([[1, 2], [3, 4]]).round(2.4, 0)).toBe(2);
      expect(frange([[1, 2], [3, 4]]).round(2.4, -1)).toBe(2);
      expect(frange([[1, 2], [3, 4]]).round(2.4, +1)).toBe(3);
      expect(frange([[1, 2], [3, 4]]).round(2.6, -1)).toBe(2);
      expect(frange([[1, 2], [3, 4]]).round(2.6, +1)).toBe(3);
      expect(frange([[1, 2], [3, 4]]).round(2.6, 0)).toBe(3);
    });
    it('should round at the ends of split ranges', function () {
      expect(frange([[1, 2], [3, 4]]).round(0,  0)).toBe(1);
      expect(frange([[1, 2], [3, 4]]).round(0, -1)).toBe(1);
      expect(frange([[1, 2], [3, 4]]).round(0, +1)).toBe(1);
      expect(frange([[1, 2], [3, 4]]).round(5,  0)).toBe(4);
      expect(frange([[1, 2], [3, 4]]).round(5, -1)).toBe(4);
      expect(frange([[1, 2], [3, 4]]).round(5, +1)).toBe(4);
    });
  });
  
  describe('StorageCell', function () {
    // TODO: break up this into individual tests
    it('should function as a cell', function () {
      // TODO: use a mock storage instead of abusing sessionStorage
      sessionStorage.clear();
      var ns = new shinysdr.values.StorageNamespace(sessionStorage, 'foo.');
      var cell = new shinysdr.values.StorageCell(ns, 'bar');
      expect(cell.get()).toBe(null);
      cell.set('a');
      expect(cell.get()).toBe('a');
      var l = createListenerSpy();
      cell.n.listen(l);
      cell.set('b');
      expect(cell.get()).toBe('b');
      expectNotification(l);
    });
  });
});
