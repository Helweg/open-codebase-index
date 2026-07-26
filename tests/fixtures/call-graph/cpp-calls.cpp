#include <memory>
#include "widget.hpp"

#define run_widget(value) helper(value)
#define helper_alias helper

using Callback = int (*)(int);
using CallbackSignature = int(int);

using namespace project::detail;

namespace project {
namespace detail {
class RemoteWidget {
public:
    explicit RemoteWidget(int value) : value_(value) {}

private:
    int value_;
};

int normalize(int value) {
    return value < 0 ? -value : value;
}
}
}

class Widget {
public:
    explicit Widget(int value) : value_(value) {}

    int run() const {
        return value_;
    }

private:
    int value_;
};

struct Point {
    int x;
    int y;

    int sum() const {
        return x + y;
    }
};

template <typename T>
T identity(T value) {
    return value;
}

int helper(int value) {
    return value + 1;
}

int normalize(int value) {
    return value + 100;
}

int declared_only(int value);
Widget make_widget();

int process(Widget* pointer, Callback callback, CallbackSignature* signature) {
    Callback local_callback = callback;
    Widget stack(1);
    Widget braced{1};
    Widget copied = Widget(1);
    Widget from_factory = make_widget();
    Widget vexing();
    project::detail::RemoteWidget remote_stack(1);
    auto* heap = new Widget(2);
    auto* remote = new project::detail::RemoteWidget(3);
    auto* point = new Point{8, 9};
    int qualified = project::detail::normalize(helper(4));
    int members = heap->run() + pointer->run() + Widget{5}.run();
    int point_value = point->sum();
    int indirect = callback(qualified);
    int local_indirect = local_callback(qualified);
    int signature_indirect = signature(qualified);
    int macro_result = run_widget(6);
    int alias_result = helper_alias(7);
    int template_result = identity<int>(8);
    delete heap;
    delete remote;
    delete point;
    return stack.run() + members + point_value + indirect + local_indirect + signature_indirect +
        macro_result + alias_result + template_result;
}
