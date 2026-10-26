using AeroDrive.Input;
using AeroDrive.SaveSystem;
using NUnit.Framework;

namespace AeroDrive.Tests
{
    /// <summary>
    /// Tests for the rebindable key map.
    /// </summary>
    /// <remarks>
    /// The failure this guards against is specific and nasty: a player rebinds a key, the map
    /// deserialises into something empty, and the game starts with a throttle that no key can press.
    /// There is no error message, the car simply does not move, and it looks like a physics bug.
    /// Every action must therefore always end up with at least one usable key.
    /// </remarks>
    public class InputBindingTests
    {
        [Test]
        public void SanitiseKeys_DropsNamesThatAreNotRealKeys()
        {
            string[] result = InputBindings.SanitiseKeys(new[] { "W", "NotAKey", "F13", "", null });

            CollectionAssert.Contains(result, "W");
            CollectionAssert.DoesNotContain(result, "NotAKey");
            CollectionAssert.DoesNotContain(result, string.Empty);
        }

        [Test]
        public void SanitiseKeys_RemovesDuplicates()
        {
            string[] result = InputBindings.SanitiseKeys(new[] { "W", "W", "UpArrow" });

            Assert.AreEqual(2, result.Length);
        }

        [Test]
        public void SanitiseKeys_RejectsNumericStringsThatWouldParseAsAKeyCode()
        {
            // Enum.TryParse happily accepts numbers and produces a KeyCode that no key will ever
            // raise. Without the IsDefined check these would be bound to an unpressable button.
            string[] result = InputBindings.SanitiseKeys(new[] { "9999", "123456" });

            Assert.AreEqual(0, result.Length);
        }

        [Test]
        public void Sanitise_FillsInEveryActionWhenTheSourceIsEmpty()
        {
            BindingEntry[] result = InputBindings.Sanitise(new BindingEntry[0]);

            Assert.AreEqual(InputBindings.Actions.Length, result.Length);

            for (int i = 0; i < result.Length; i++)
            {
                Assert.Greater(result[i].keys.Length, 0, $"\"{result[i].action}\" was left without a key.");
            }
        }

        [Test]
        public void Sanitise_FallsBackToDefaultsForAnUnreadableAction()
        {
            BindingEntry[] source =
            {
                new BindingEntry(InputBindings.Accelerate, "NotAKey"),
                new BindingEntry(InputBindings.Brake, "S"),
            };

            BindingEntry[] result = InputBindings.Sanitise(source);

            string[] accelerate = InputBindings.KeysFor(result, InputBindings.Accelerate);
            CollectionAssert.Contains(accelerate, "W");

            string[] brake = InputBindings.KeysFor(result, InputBindings.Brake);
            CollectionAssert.Contains(brake, "S");
            CollectionAssert.DoesNotContain(brake, "DownArrow");
        }

        [Test]
        public void Sanitise_DropsActionsThatNoSystemKnowsAbout()
        {
            BindingEntry[] source = { new BindingEntry("fly", "F") };
            BindingEntry[] result = InputBindings.Sanitise(source);

            Assert.AreEqual(InputBindings.Actions.Length, result.Length);
            for (int i = 0; i < result.Length; i++)
            {
                Assert.AreNotEqual("fly", result[i].action);
            }
        }

        [Test]
        public void Sanitise_KeepsBothKeysOfATwoKeyAction()
        {
            BindingEntry[] source = { new BindingEntry(InputBindings.Accelerate, "W", "UpArrow") };
            BindingEntry[] result = InputBindings.Sanitise(source);

            string[] keys = InputBindings.KeysFor(result, InputBindings.Accelerate);
            Assert.AreEqual(2, keys.Length);
        }

        [Test]
        public void Sanitise_ReturnsTheActionsInTheDeclaredOrder()
        {
            BindingEntry[] result = InputBindings.Sanitise(null);

            for (int i = 0; i < InputBindings.Actions.Length; i++)
            {
                Assert.AreEqual(InputBindings.Actions[i], result[i].action);
            }
        }

        [Test]
        public void Sanitise_KeepsEscapeAsTheDefaultPauseKey()
        {
            BindingEntry[] result = InputBindings.Sanitise(null);
            string[] pause = InputBindings.KeysFor(result, InputBindings.Pause);

            CollectionAssert.Contains(pause, "Escape");
        }

        [Test]
        public void KeysFor_ReturnsEmptyForAnUnknownAction()
        {
            Assert.AreEqual(0, InputBindings.KeysFor(null, "anything").Length);
        }

        [Test]
        public void LabelFor_ReturnsSomethingReadableForEveryAction()
        {
            for (int i = 0; i < InputBindings.Actions.Length; i++)
            {
                string action = InputBindings.Actions[i];
                string label = InputBindings.LabelFor(action);

                Assert.IsNotEmpty(label);
                Assert.AreNotEqual(action, label, $"\"{action}\" has no readable label for the settings menu.");
            }
        }
    }
}
