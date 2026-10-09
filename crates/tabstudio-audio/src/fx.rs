//! A track's insert effects in mixer order (src/mixer-audio.ts configure()): each enabled
//! EQ / compressor / delay with the same parameter mapping from its 0..1 amount.
//! Built on a control thread (it allocates), then swapped into the engine.
use crate::compressor::Compressor;
use crate::dsp::{Biquad, Delay, FilterKind};

pub enum Fx {
    /// Peaking at 1200 Hz, gain (amount - 0.5) x 24 dB.
    Eq(Biquad),
    /// Threshold -10 - 30 x amount dB, ratio 2 + 6 x amount (WebAudio knee/attack/release defaults).
    Compressor(Compressor),
    /// 0.3 s echo, feedback 0.3, wet = amount.
    Delay(Delay),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FxKind {
    Eq,
    Compressor,
    Delay,
}

pub struct FxChain {
    items: Vec<Fx>,
}

impl FxChain {
    pub fn new(specs: &[(FxKind, f32)], sample_rate: f64) -> FxChain {
        let items = specs
            .iter()
            .map(|&(kind, amount)| match kind {
                FxKind::Eq => Fx::Eq(Biquad::new(FilterKind::Peaking, 1200.0, 1.0, ((amount - 0.5) * 24.0) as f64, sample_rate)),
                FxKind::Compressor => Fx::Compressor(Compressor::new(sample_rate, -10.0 - 30.0 * amount, 30.0, 2.0 + 6.0 * amount, 0.003, 0.25)),
                FxKind::Delay => Fx::Delay(Delay::new(sample_rate, amount)),
            })
            .collect();
        FxChain { items }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for fx in &mut self.items {
            match fx {
                Fx::Eq(f) => f.process_stereo(left, right),
                Fx::Compressor(c) => c.process(left, right),
                Fx::Delay(d) => d.process(left, right),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_runs_in_order_and_empty_is_transparent() {
        let mut empty = FxChain::new(&[], 48000.0);
        let (mut l, mut r) = (vec![0.5f32; 64], vec![-0.5f32; 64]);
        empty.process(&mut l, &mut r);
        assert!(empty.is_empty() && l.iter().all(|v| *v == 0.5) && r.iter().all(|v| *v == -0.5));
        let mut chain = FxChain::new(&[(FxKind::Delay, 1.0)], 48000.0);
        let (mut l, mut r) = (vec![0f32; 20000], vec![0f32; 20000]);
        l[0] = 1.0;
        chain.process(&mut l, &mut r);
        assert_eq!(l[14400], 1.0);
    }
}
