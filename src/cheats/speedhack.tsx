import { BindHolder, Bind } from "../krunker-ui/components/Bind";
import { Slider } from "../krunker-ui/components/Slider";
import { Switch } from "../krunker-ui/components/Switch";
import { getGame, preRenderHooks } from "../filters";
import sketchConfig, { useSketchConfig } from "../sketchConfig";

let isSpeedKeyHeld = false;
let savedSpeed:
  | {
      config: { deltaMlt?: number };
      hadValue: boolean;
      value: number | undefined;
    }
  | undefined;

function restoreHoldSpeed() {
  if (!savedSpeed) return;

  if (savedSpeed.hadValue) savedSpeed.config.deltaMlt = savedSpeed.value;
  else delete savedSpeed.config.deltaMlt;
  savedSpeed = undefined;
}

function handleHoldSpeed() {
  if (!sketchConfig.get("speedHack") || !isSpeedKeyHeld) {
    restoreHoldSpeed();
    return;
  }

  const config = getGame().config;
  if (!savedSpeed) {
    savedSpeed = {
      config,
      hadValue: Object.prototype.hasOwnProperty.call(config, "deltaMlt"),
      value: config.deltaMlt,
    };
  }

  config.deltaMlt = sketchConfig.get("speedAmount");
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => {
    const speedKey = sketchConfig.get("speedKey");
    if (
      sketchConfig.get("speedHack") &&
      speedKey !== -1 &&
      event.keyCode === speedKey
    )
      isSpeedKeyHeld = true;
  });

  window.addEventListener("keyup", (event) => {
    if (event.keyCode === sketchConfig.get("speedKey")) {
      isSpeedKeyHeld = false;
      restoreHoldSpeed();
    }
  });

  window.addEventListener("blur", () => {
    isSpeedKeyHeld = false;
    restoreHoldSpeed();
  });
}

preRenderHooks.push(handleHoldSpeed);

export function SpeedhackMenu() {
  const [speedHack, setSpeedHack] = useSketchConfig("speedHack");
  const [speedKey, setSpeedKey] = useSketchConfig("speedKey");
  const [speedAmount, setSpeedAmount] = useSketchConfig("speedAmount");

  return (
    <>
      <BindHolder title="Speed Hold Key">
        <Bind
          bind={speedKey}
          setBind={setSpeedKey}
          reset={() => setSpeedKey()}
          unbind={() => setSpeedKey(-1)}
        />
      </BindHolder>
      <Switch
        title="Hold Speed Hack"
        description="Temporarily changes movement speed while the selected key is held."
        defaultChecked={speedHack}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          setSpeedHack(enabled);
          if (!enabled) {
            isSpeedKeyHeld = false;
            restoreHoldSpeed();
          }
        }}
      />
      <Slider
        title="Speed Multiplier"
        defaultValue={speedAmount}
        min={0.1}
        max={2.5}
        step={0.05}
        onChange={(event) =>
          setSpeedAmount(event.currentTarget.valueAsNumber)
        }
      />
    </>
  );
}