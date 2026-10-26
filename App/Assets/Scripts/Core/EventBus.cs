using System;
using System.Collections.Generic;

namespace AeroDrive.Core
{
    /// <summary>
    /// A minimal, allocation-conscious event bus.
    /// </summary>
    /// <remarks>
    /// Systems need to react to each other (a gear change must reach the HUD and the audio engine)
    /// without holding direct references to one another. A bus of strongly typed events keeps those
    /// systems independent and, more importantly, keeps them unit-testable: a test can raise an
    /// event and assert on a subscriber without standing up a scene.
    ///
    /// Deliberately small. There is no priority, no cancellation, and no string keys — if you find
    /// yourself wanting those, a direct call is probably the better design. Subscribers are invoked
    /// over a snapshot of the list so a handler may safely unsubscribe itself while it runs.
    /// </remarks>
    public sealed class EventBus
    {
        private readonly Dictionary<Type, List<Delegate>> _handlers = new Dictionary<Type, List<Delegate>>();

        /// <summary>Subscribe to <typeparamref name="T"/>. Returns a handle that unsubscribes when disposed.</summary>
        public IDisposable Subscribe<T>(Action<T> handler) where T : struct
        {
            if (handler == null) throw new ArgumentNullException(nameof(handler));

            Type key = typeof(T);
            if (!_handlers.TryGetValue(key, out List<Delegate> list))
            {
                list = new List<Delegate>(4);
                _handlers[key] = list;
            }

            list.Add(handler);
            return new Subscription(() => Unsubscribe(handler));
        }

        /// <summary>Remove a previously registered handler. Safe to call when it was never added.</summary>
        public void Unsubscribe<T>(Action<T> handler) where T : struct
        {
            if (handler == null) return;
            if (!_handlers.TryGetValue(typeof(T), out List<Delegate> list)) return;

            list.Remove(handler);
        }

        /// <summary>Publish an event to every current subscriber.</summary>
        public void Publish<T>(T payload) where T : struct
        {
            if (!_handlers.TryGetValue(typeof(T), out List<Delegate> list)) return;

            // Iterate a copy: a handler that subscribes or unsubscribes during dispatch must not
            // mutate the collection being walked.
            Delegate[] snapshot = list.ToArray();
            for (int i = 0; i < snapshot.Length; i++)
            {
                ((Action<T>)snapshot[i]).Invoke(payload);
            }
        }

        /// <summary>Drop every handler. Used when tearing a session down.</summary>
        public void Clear()
        {
            _handlers.Clear();
        }

        private sealed class Subscription : IDisposable
        {
            private Action _unsubscribe;

            public Subscription(Action unsubscribe)
            {
                _unsubscribe = unsubscribe;
            }

            public void Dispose()
            {
                _unsubscribe?.Invoke();
                _unsubscribe = null;
            }
        }
    }
}
