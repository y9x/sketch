import { BindHolder, Bind } from "../krunker-ui/components/Bind";
import { Slider } from "../krunker-ui/components/Slider";
import { Switch } from "../krunker-ui/components/Switch";
import { getExposedWindow } from "../consts";
import sketchConfig, { useSketchConfig } from "../sketchConfig";

let isFpsDropperHeld = false;

function initFpsDropperHook() {
  const gameWindow = getExposedWindow();

  const originalRequestAnimationFrame =
    gameWindow.requestAnimationFrame.bind(gameWindow);
  let lastFrameTime = performance.now();

  gameWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    if (
      sketchConfig.get("fpsDropper") &&
      isFpsDropperHeld
    ) {
      const targetFps = sketchConfig.get("fpsDropperValue");
      const frameDelay = 1000 / targetFps;
      const now = performance.now();
      const elapsed = now - lastFrameTime;

      if (elapsed < frameDelay) {
        return gameWindow.setTimeout(
          () => originalRequestAnimationFrame(callback),
          frameDelay - elapsed,
        );
      }

      lastFrameTime = now;
    } else {
      lastFrameTime = performance.now();
    }

    return originalRequestAnimationFrame(callback);
  }) as typeof window.requestAnimationFrame;
}

if (typeof window !== "undefined") {
  const gameWindow = getExposedWindow();

  gameWindow.addEventListener("keydown", (event) => {
    const fpsDropperKey = sketchConfig.get("fpsDropperKey");
    if (
      sketchConfig.get("fpsDropper") &&
      fpsDropperKey !== -1 &&
      event.keyCode === fpsDropperKey
    )
      isFpsDropperHeld = true;
  });

  gameWindow.addEventListener("keyup", (event) => {
    if (event.keyCode === sketchConfig.get("fpsDropperKey"))
      isFpsDropperHeld = false;
  });

  gameWindow.addEventListener("blur", () => {
    isFpsDropperHeld = false;
  });

  initFpsDropperHook();
}

export function FpsDropperMenu() {
  const [fpsDropper, setFpsDropper] = useSketchConfig("fpsDropper");
  const [fpsDropperKey, setFpsDropperKey] =
    useSketchConfig("fpsDropperKey");
  const [fpsDropperValue, setFpsDropperValue] =
    useSketchConfig("fpsDropperValue");

  return (
    <>
      <BindHolder title="FPS Dropper Hold Key">
        <Bind
          bind={fpsDropperKey}
          setBind={setFpsDropperKey}
          reset={() => setFpsDropperKey()}
          unbind={() => setFpsDropperKey(-1)}
        />
      </BindHolder>
      <Switch
        title="FPS Dropper"
        description="Limits requestAnimationFrame while the selected key is held."
        defaultChecked={fpsDropper}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          setFpsDropper(enabled);
          if (!enabled) isFpsDropperHeld = false;
        }}
      />
      <Slider
        title="Target FPS"
        defaultValue={fpsDropperValue}
        min={1}
        max={30}
        step={1}
        onChange={(event) =>
          setFpsDropperValue(event.currentTarget.valueAsNumber)
        }
      />
    </>
  );
}