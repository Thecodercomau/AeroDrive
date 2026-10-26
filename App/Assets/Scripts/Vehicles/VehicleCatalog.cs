using System;
using UnityEngine;

namespace AeroDrive.Vehicles
{
    /// <summary>One entry in the garage: a car, its prefab, and how it is unlocked.</summary>
    [Serializable]
    public class VehicleCatalogEntry
    {
        [Tooltip("The handling data. Its vehicleId is what the save file stores.")]
        public VehicleConfig config;

        [Tooltip("Prefab instantiated for the player. Its colliders and wheel colliders must match the config.")]
        public GameObject prefab;

        [Tooltip("Locked until the player completes a challenge.")]
        public bool requiresUnlock;

        [Tooltip("Challenge id whose completion unlocks this car. Empty means unlocked from the start.")]
        public string unlockedByChallengeId;

        /// <summary>Display name, falling back to the asset name so the list is never blank.</summary>
        public string DisplayName
        {
            get
            {
                if (config == null) return "(missing config)";
                return string.IsNullOrEmpty(config.displayName) ? config.name : config.displayName;
            }
        }

        /// <summary>Stable id used in the save file.</summary>
        public string VehicleId
        {
            get { return config != null ? config.vehicleId : string.Empty; }
        }
    }

    /// <summary>
    /// The list of cars the player can drive, and the rules for unlocking them.
    /// </summary>
    /// <remarks>
    /// A catalogue rather than a folder scan: building the list at edit time catches a car with a
    /// missing config or a duplicate id in the Inspector, where it can be fixed, instead of at
    /// startup on a player's machine. <see cref="Validate"/> reports exactly those two mistakes.
    /// </remarks>
    [CreateAssetMenu(fileName = "VehicleCatalog", menuName = "AeroDrive/Vehicle Catalog", order = 1)]
    public sealed class VehicleCatalog : ScriptableObject
    {
        public VehicleCatalogEntry[] entries = new VehicleCatalogEntry[0];

        /// <summary>Number of entries, including any that are invalid.</summary>
        public int Count
        {
            get { return entries != null ? entries.Length : 0; }
        }

        /// <summary>Find an entry by vehicle id. Returns null when it is not in the catalogue.</summary>
        public VehicleCatalogEntry Find(string vehicleId)
        {
            if (string.IsNullOrEmpty(vehicleId) || entries == null) return null;

            for (int i = 0; i < entries.Length; i++)
            {
                if (entries[i] != null && entries[i].VehicleId == vehicleId) return entries[i];
            }

            return null;
        }

        /// <summary>Index of an entry, or -1.</summary>
        public int IndexOf(string vehicleId)
        {
            if (string.IsNullOrEmpty(vehicleId) || entries == null) return -1;

            for (int i = 0; i < entries.Length; i++)
            {
                if (entries[i] != null && entries[i].VehicleId == vehicleId) return i;
            }

            return -1;
        }

        /// <summary>The first entry that is not locked, used as a fallback selection.</summary>
        public VehicleCatalogEntry FirstUnlocked()
        {
            if (entries == null) return null;

            for (int i = 0; i < entries.Length; i++)
            {
                if (entries[i] != null && !entries[i].requiresUnlock) return entries[i];
            }

            return Count > 0 ? entries[0] : null;
        }

        /// <summary>
        /// Check the catalogue and report every problem found.
        /// </summary>
        /// <returns>True when the catalogue is usable.</returns>
        public bool Validate()
        {
            bool valid = true;

            if (entries == null || entries.Length == 0)
            {
                Debug.LogError($"[AeroDrive] Vehicle catalog \"{name}\" is empty.", this);
                return false;
            }

            System.Collections.Generic.HashSet<string> seen = new System.Collections.Generic.HashSet<string>();

            for (int i = 0; i < entries.Length; i++)
            {
                VehicleCatalogEntry entry = entries[i];

                if (entry == null || entry.config == null)
                {
                    Debug.LogError($"[AeroDrive] Vehicle catalog \"{name}\" entry {i} has no config.", this);
                    valid = false;
                    continue;
                }

                string id = entry.VehicleId;
                if (string.IsNullOrEmpty(id))
                {
                    Debug.LogError($"[AeroDrive] Vehicle catalog entry {i} (\"{entry.config.name}\") has an empty vehicleId.", this);
                    valid = false;
                    continue;
                }

                // A duplicate id means two cars share one save-file slot, so unlocking one would
                // unlock the other and progress would be meaningless.
                if (!seen.Add(id))
                {
                    Debug.LogError($"[AeroDrive] Vehicle catalog \"{name}\" has more than one entry with id \"{id}\".", this);
                    valid = false;
                }
            }

            return valid;
        }

        /// <summary>Ids that are unlocked from the start, for seeding a fresh save file.</summary>
        public string[] StartingVehicleIds()
        {
            if (entries == null) return Array.Empty<string>();

            System.Collections.Generic.List<string> ids = new System.Collections.Generic.List<string>();
            for (int i = 0; i < entries.Length; i++)
            {
                VehicleCatalogEntry entry = entries[i];
                if (entry == null || entry.config == null || entry.requiresUnlock) continue;
                if (!ids.Contains(entry.VehicleId)) ids.Add(entry.VehicleId);
            }

            return ids.ToArray();
        }
    }
}
