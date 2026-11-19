//! The global Flow clock (`src/flowState.js`).
use crate::{
    fight::obj,
    round::{js_max, js_min},
    value::Value::{self, Num, Undefined},
};

pub struct FlowState {
    pub max: f64,
    pub seconds: f64,
    pub held: f64,
    pub until: f64,
}

pub struct FlowHit {
    pub before: f64,
    pub after: f64,
    pub until: f64,
    pub built: bool,
}

impl FlowState {
    pub fn new(opts: &Value) -> Self {
        let read = |key, default| match opts.get(key) {
            Undefined => default,
            v => v.num_or_default(0.0),
        };
        let max = js_max(0.0, read("max", 5.0).floor());
        Self {
            max,
            seconds: js_max(0.0, read("seconds", 6.0)),
            held: js_max(0.0, js_min(max, read("stacks", 0.0).floor())),
            until: read("until", 0.0),
        }
    }

    pub fn stacks_at(&self, t: f64) -> f64 {
        if t < self.until {
            self.held
        } else {
            0.0
        }
    }

    pub fn hit(&mut self, t: f64, whole: bool, eligible: bool) -> FlowHit {
        let before = self.stacks_at(t);
        let built = whole && eligible;
        if built {
            self.held = js_min(self.max, before + 1.0);
            self.until = t + self.seconds;
        }
        FlowHit {
            before,
            after: if built { self.held } else { before },
            until: self.until,
            built,
        }
    }

    pub fn state(&self, t: f64) -> Value {
        obj([
            ("stacks", Num(self.stacks_at(t))),
            ("held", Num(self.held)),
            ("until", Num(self.until)),
            ("max", Num(self.max)),
            ("seconds", Num(self.seconds)),
        ])
    }
}
