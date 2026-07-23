// Shared "segmented control" helper: toggles the `active` class on each
// button inside `control` based on whether its `dataset[dataKey]` matches
// `value`. Used by any settings-style control made of a fixed row of
// pre-rendered buttons (as opposed to a dynamically-rendered chip list).
export function renderSegmentedControl(control, value, dataKey) {
  control?.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset[dataKey] === String(value));
  });
}
