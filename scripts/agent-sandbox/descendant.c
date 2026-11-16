// Synthetic M0 lifecycle fixture. No network, user data, or persistent service.
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
        if (setsid() < 0) _exit(4);
        FILE *out = fopen(argv[1], "w");
        if (!out) _exit(5);
        fprintf(out, "%d\n", getpid()); fclose(out);
        close(0); close(1); close(2);
        // Heartbeat proves activity rather than mistaking a zombie for a live process.
        for (int i = 0; i < 100; i++) {
            out = fopen(argv[1], "a");
            if (out) { fputc('.', out); fclose(out); }
            usleep(100000);
        } // Independently self-terminates even if probe cleanup fails.
        _exit(0);
    }
    sleep(10);
    return 0;
}
