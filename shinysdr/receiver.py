# Copyright 2013 Kevin Reid <kpreid@switchb.org>
# 
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

from __future__ import absolute_import, division

from twisted.plugin import IPlugin, getPlugins
from zope.interface import Interface, implements  # available via Twisted

import gnuradio
from gnuradio import analog
from gnuradio import gr
from gnuradio import blocks

import math

from shinysdr.values import ExportedState, BlockCell, Range, Enum, exported_value, setter
from shinysdr import plugins


class Receiver(gr.hier_block2, ExportedState):
	def __init__(self, mode,
			input_rate=0,
			input_center_freq=0,
			audio_rate=0,
			rec_freq=100.0,
			audio_gain=0.25,
			audio_pan=0,
			context=None):
		assert input_rate > 0
		assert audio_rate > 0
		gr.hier_block2.__init__(
			# str() because insists on non-unicode
			self, str('%s receiver' % (mode,)),
			gr.io_signature(1, 1, gr.sizeof_gr_complex * 1),
			gr.io_signature(2, 2, gr.sizeof_float * 1),
		)
		
		# Provided by caller
		self.input_rate = input_rate
		self.input_center_freq = input_center_freq
		self.audio_rate = audio_rate
		self.context = context
		
		# Simple state
		self.mode = mode
		self.rec_freq = rec_freq
		self.audio_gain = audio_gain
		self.audio_pan = min(1, max(-1, audio_pan))
		
		
		# Blocks
		self.oscillator = analog.sig_source_c(input_rate, analog.GR_COS_WAVE, -rec_freq, 1, 0)
		self.mixer = blocks.multiply_cc(1)
		self.demodulator = self.__make_demodulator(mode, {})
		self.audio_gain_l_block = blocks.multiply_const_ff(self.audio_gain)
		self.audio_gain_r_block = blocks.multiply_const_ff(self.audio_gain)
		self.probe_audio = analog.probe_avg_mag_sqrd_f(0, alpha=10.0/audio_rate)
		
		self.__do_connect()
	
	def state_def(self, callback):
		super(Receiver, self).state_def(callback)
		# TODO decoratorify
		callback(BlockCell(self, 'demodulator'))
	
	def __do_connect(self):
		self.context.lock()
		try:
			self.disconnect_all()
			
			self.connect(self.oscillator, (self.mixer, 1))
			self.connect(self, self.mixer, self.demodulator)
			self.connect((self.demodulator, 0), self.audio_gain_l_block, (self, 0))
			self.connect((self.demodulator, 1), self.audio_gain_r_block, (self, 1))
			
			self.connect((self.demodulator, 0), self.probe_audio)
		finally:
			self.context.unlock()

	def set_input_rate(self, value):
		value = int(value)
		if self.input_rate == value:
			return
		self.input_rate = value
		self.oscillator.set_sampling_freq(self.input_rate)
		self._rebuild_demodulator()

	def set_input_center_freq(self, value):
		self.input_center_freq = value
		self.__update_oscillator()
		# note does not revalidate() because the caller will handle that

	# type construction is deferred because we don't want loading this file to trigger loading plugins
	@exported_value(ctor_fn=lambda self: Enum({d.mode: d.label for d in getModes()}))
	def get_mode(self):
		return self.mode
	
	@setter
	def set_mode(self, mode):
		mode = unicode(mode)
		if self.demodulator and self.demodulator.can_set_mode(mode):
			self.demodulator.set_mode(mode)
			self.mode = mode
		else:
			self._rebuild_demodulator(mode=mode)

	# TODO: rename rec_freq to just freq
	@exported_value(ctor=float)
	def get_rec_freq(self):
		return self.rec_freq
	
	@setter
	def set_rec_freq(self, rec_freq):
		self.rec_freq = float(rec_freq)
		self.__update_oscillator()
		self.context.revalidate()
	
	# TODO: support non-audio demodulators at which point these controls should be optional
	@exported_value(ctor=Range([(0.001, 100)], strict=False, logarithmic=True))
	def get_audio_gain(self):
		return self.audio_gain

	@setter
	def set_audio_gain(self, value):
		self.audio_gain = value
		self.__update_audio_gain()
	
	@exported_value(ctor=Range([(-1, 1)], strict=True))
	def get_audio_pan(self):
		return self.audio_pan
	
	@setter
	def set_audio_pan(self, value):
		self.audio_pan = value
		self.__update_audio_gain()
	
	@exported_value(ctor=bool)
	def get_is_valid(self):
		valid_bandwidth = self.input_rate / 2 - abs(self.rec_freq - self.input_center_freq)
		return self.demodulator is not None and valid_bandwidth >= self.demodulator.get_half_bandwidth()
	
	# Note that we cannot measure RF power at this point because we don't know what the channel bandwidth is.
	@exported_value(ctor=Range([(-60, 0)], strict=False))
	def get_audio_power(self):
		if self.get_is_valid():
			return 10 * math.log10(max(1e-6, self.probe_audio.level()))
		else:
			# will not be receiving samples, so value will be meaningless
			return 0.0
	
	def __update_oscillator(self):
		self.oscillator.set_frequency(self.input_center_freq - self.rec_freq)
	
	# called from facet
	def _rebuild_demodulator(self, mode=None):
		self.__rebuild_demodulator_nodirty(mode)
		self.__do_connect()

	def __rebuild_demodulator_nodirty(self, mode=None):
		if self.demodulator is None:
			defaults = {}
		else:
			defaults = self.demodulator.state_to_json()
		if mode is None:
			mode = self.mode
		self.demodulator = self.__make_demodulator(mode, defaults)
		self.mode = mode

	def __make_demodulator(self, mode, state):
		'''Returns the demodulator.'''

		for modeDef in getModes():
			if modeDef.mode == mode:
				clas = modeDef.demodClass
				break
		else:
			raise ValueError('Unknown mode: ' + mode)

		# TODO: extend state_from_json so we can decide to load things with keyword args and lose the init dict/state dict distinction
		init = {}
		state = state.copy()  # don't modify arg
		if 'mode' in state: del state['mode']  # prevent conflict

		# TODO generalize this special case for WFM demodulator
		if mode == 'WFM':
			if 'stereo' in state:
				init['stereo'] = state['stereo']
			if 'audio_filter' in state:
				init['audio_filter'] = state['audio_filter']

		facet = ContextForDemodulator(self)
		demodulator = clas(
			mode=mode,
			input_rate=self.input_rate,
			audio_rate=self.audio_rate,
			context=facet,
			**init
		)
		demodulator.state_from_json(state)
		# until _enabled, ignore any callbacks resulting from the state_from_json initialization
		facet._enabled = True
		return demodulator

	def __update_audio_gain(self):
		gain = self.audio_gain
		pan = self.audio_pan
		# TODO: Determine correct computation for panning. http://en.wikipedia.org/wiki/Pan_law seems relevant but was short on actual formulas. May depend on headphones vs speakers? This may be correct already for headphones -- it sounds nearly-flat to me.
		self.audio_gain_l_block.set_k(gain * (1 - pan))
		self.audio_gain_r_block.set_k(gain * (1 + pan))


class ContextForDemodulator(object):
	def __init__(self, receiver):
		self._receiver = receiver
		self._enabled = False # assigned outside
	
	def revalidate(self):
		raise NotImplementedError('ContextForDemodulator not done')
		if self._enabled:
			self._receiver.context._update_receiver_validity(self._key)
	
	def rebuild_me(self):
		assert self._enabled
		self._receiver._rebuild_demodulator()

	def lock(self):
		self._receiver.context.lock()

	def unlock(self):
		self._receiver.context.unlock()


class IDemodulator(Interface):
	def can_set_mode(mode):
		'''
		Return whether this demodulator can reconfigure itself to demodulate the specified mode.
		
		If it returns False, it will typically be replaced with a newly created demodulator.
		'''
	
	def set_mode(mode):
		'''
		Per can_set_mode.
		'''
	
	def get_half_bandwidth():
		'''
		TODO explain
		'''


class IModeDef(Interface):
	'''
	Demodulator plugin interface object
	'''
	# Only needed to make the plugin system work
	# TODO write interface methods anyway


class ModeDef(object):
	implements(IPlugin, IModeDef)
	
	# Twisted plugin system caches whether-a-plugin-class-was-found permanently, so we need to avoid _not_ having a ModeDef if the plugin has some sort of dependency it checks -- thus the 'available' flag can be used to hide a mode while still having an IModeDef
	def __init__(self, mode, label, demodClass, available=True):
		self.mode = mode
		self.label = label
		self.demodClass = demodClass
		self.available = available


def getModes():
	# TODO caching? prebuilt mode table?
	return [p for p in getPlugins(IModeDef, plugins) if p.available]
