#include <stdio.h>
#include "helpers.h"

#define call_helper(value) helper(value)
#define helper_alias helper

typedef int (*callback_fn)(int);

struct external_api {
    long first;
    long second;
    long third;
    long fourth;
    long fifth;
    long sixth;
};

int external_api(int value);

int helper(int value) {
    return value + 1;
}

int compute(int value) {
    return helper(value) * 2;
}

int invoke(callback_fn callback, int value) {
    callback_fn local_callback = callback;
    return callback(value) + local_callback(value);
}

int inspect(void) {
    return external_api(1);
}

int declared_only(int value);

int main(void) {
    int result = compute(3);
    int macro_result = call_helper(4);
    int alias_result = helper_alias(5);
    printf("%d\n", result + macro_result + alias_result);
    return result;
}
