using System;
using System.Collections.Generic;
using AeroDrive.SaveSystem;
using UnityEngine;

namespace AeroDrive.Input
{
    /// <summary>
    /// The rebindable keyboard map and the actions it covers.
    /// </summary>
    /// <remarks>
    /// Actions are named by string constants rather than by an enum so a save file can name them
    /// directly and a new action can be added without invalidating every existing file. The set of
    /// valid actions is still fixed here, and <see cref="Sanitise"/> drops anything unknown.
    /// </remarks>
    public static class InputBindings
    {
        public const string Accelerate = "accelerate";
        public const string Brake = "brake";
        public const string SteerLeft = "steerLeft";
        public const string SteerRight = "steerRight";
        public const string Handbrake = "handbrake";
        public const string ShiftUp = "shiftUp";
        public const string ShiftDown = "shiftDown";
        public const string Camera = "camera";
        public const string Recover = "recover";
        public const string Headlights = "headlights";
        public const string Horn = "horn";
        public const string Pause = "pause";

        /// <summary>Every action in the order it should appear in the settings menu.</summary>
        public static readonly string[] Actions =
        {
            Accelerate, Brake, SteerLeft, SteerRight, Handbrake, ShiftUp, ShiftDown,
            Camera, Recover, Headlights, Horn, Pause,
        };

        /// <summary>Human-readable label for the settings menu.</summary>
        public static string LabelFor(string action)
        {
            switch (action)
            {
                case Accelerate: return "Accelerate";
                case Brake: return "Brake / reverse";
                case SteerLeft: return "Steer left";
                case SteerRight: return "Steer right";
                case Handbrake: return "Handbrake";
                case ShiftUp: return "Upshift";
                case ShiftDown: return "Downshift";
                case Camera: return "Change camera";
                case Recover: return "Recover vehicle";
                case Headlights: return "Headlights";
                case Horn: return "Horn";
                case Pause: return "Pause";
                default: return action;
            }
        }

        /// <summary>A fresh set of defaults, as save-file entries.</summary>
        public static BindingEntry[] CreateDefaultEntries()
        {
            return new[]
            {
                new BindingEntry(Accelerate, KeyCode.W.ToString(), KeyCode.UpArrow.ToString()),
                new BindingEntry(Brake, KeyCode.S.ToString(), KeyCode.DownArrow.ToString()),
                new BindingEntry(SteerLeft, KeyCode.A.ToString(), KeyCode.LeftArrow.ToString()),
                new BindingEntry(SteerRight, KeyCode.D.ToString(), KeyCode.RightArrow.ToString()),
                new BindingEntry(Handbrake, KeyCode.Space.ToString()),
                new BindingEntry(ShiftUp, KeyCode.LeftShift.ToString()),
                new BindingEntry(ShiftDown, KeyCode.LeftControl.ToString()),
                new BindingEntry(Camera, KeyCode.C.ToString()),
                new BindingEntry(Recover, KeyCode.R.ToString()),
                new BindingEntry(Headlights, KeyCode.H.ToString()),
                new BindingEntry(Horn, KeyCode.F.ToString()),
                new BindingEntry(Pause, KeyCode.Escape.ToString()),
            };
        }

        /// <summary>
        /// Coerce a loaded set of entries into a complete, valid map.
        /// </summary>
        /// <remarks>
        /// Missing actions are filled from the defaults and an action whose keys are all unparseable
        /// falls back to its default too, so a control can never end up with no key at all — which
        /// would leave the player unable to drive and with no obvious way to find out why.
        /// </remarks>
        public static BindingEntry[] Sanitise(BindingEntry[] source)
        {
            BindingEntry[] defaults = CreateDefaultEntries();
            Dictionary<string, BindingEntry> byAction = new Dictionary<string, BindingEntry>();

            if (source != null)
            {
                for (int i = 0; i < source.Length; i++)
                {
                    BindingEntry entry = source[i];
                    if (entry == null || string.IsNullOrEmpty(entry.action)) continue;
                    if (Array.IndexOf(Actions, entry.action) < 0) continue;

                    string[] valid = SanitiseKeys(entry.keys);
                    if (valid.Length == 0) continue;

                    byAction[entry.action] = new BindingEntry(entry.action, valid);
                }
            }

            BindingEntry[] result = new BindingEntry[Actions.Length];
            for (int i = 0; i < Actions.Length; i++)
            {
                string action = Actions[i];
                result[i] = byAction.TryGetValue(action, out BindingEntry found)
                    ? found
                    : FindDefault(defaults, action);
            }

            return result;
        }

        /// <summary>Keep only names that are real <see cref="KeyCode"/> values, dropping duplicates.</summary>
        public static string[] SanitiseKeys(string[] keys)
        {
            List<string> valid = new List<string>(2);
            if (keys == null) return valid.ToArray();

            for (int i = 0; i < keys.Length; i++)
            {
                string name = keys[i];
                if (string.IsNullOrEmpty(name)) continue;

                // Only names that parse are kept. `Enum.TryParse` would happily accept "12" and
                // produce a nonsense KeyCode, so the result is verified to be a defined name.
                if (!Enum.TryParse(name, out KeyCode parsed)) continue;
                if (!Enum.IsDefined(typeof(KeyCode), parsed)) continue;

                string canonical = parsed.ToString();
                if (!valid.Contains(canonical)) valid.Add(canonical);
            }

            return valid.ToArray();
        }

        public static string[] KeysFor(BindingEntry[] entries, string action)
        {
            if (entries == null) return Array.Empty<string>();

            for (int i = 0; i < entries.Length; i++)
            {
                if (entries[i] != null && entries[i].action == action) return entries[i].keys ?? Array.Empty<string>();
            }

            return Array.Empty<string>();
        }

        private static BindingEntry FindDefault(BindingEntry[] defaults, string action)
        {
            for (int i = 0; i < defaults.Length; i++)
            {
                if (defaults[i].action == action) return defaults[i];
            }

            // Cannot happen while Actions and CreateDefaultEntries agree, but returning something
            // usable is still better than returning null.
            return new BindingEntry(action);
        }
    }
}
