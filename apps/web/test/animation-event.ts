// jsdom has no AnimationEvent, so React would listen for the old webkit-prefixed animation events instead of
// "animationend" (which every browser sends, and fireEvent.animationEnd dispatches).
if (!("AnimationEvent" in window)) (window as { AnimationEvent?: unknown }).AnimationEvent = class AnimationEvent extends Event {};
