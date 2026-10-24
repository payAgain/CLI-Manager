#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Harmless native processes for real-PTY ancestry and job-control tests. */
static int wait_for_child(pid_t child) {
    int status;
    while (waitpid(child, &status, 0) < 0) {
        if (errno == EINTR) continue;
        perror("agent fixture: waitpid");
        return EXIT_FAILURE;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return EXIT_FAILURE;
}

static int echo_input(void) {
    char buffer[4096];
    for (;;) {
        ssize_t length = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (length == 0) return EXIT_SUCCESS;
        if (length < 0) {
            if (errno == EINTR) continue;
            perror("agent fixture: read");
            return EXIT_FAILURE;
        }
        ssize_t offset = 0;
        while (offset < length) {
            ssize_t written = write(STDOUT_FILENO, buffer + offset, (size_t)(length - offset));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) {
                perror("agent fixture: write");
                return EXIT_FAILURE;
            }
            offset += written;
        }
    }
}

int main(int argc, char **argv) {
    if (argc == 1) return echo_input();
    if (argc >= 3 && strcmp(argv[1], "--launch") == 0) {
        pid_t child = fork();
        if (child < 0) {
            perror("agent fixture: fork launcher");
            return EXIT_FAILURE;
        }
        if (child == 0) {
            execv(argv[2], &argv[2]);
            perror("agent fixture: execv");
            _exit(127);
        }
        return wait_for_child(child);
    }
    if (argc == 3 && strcmp(argv[1], "--helper") == 0) {
        pid_t child = fork();
        if (child < 0) {
            perror("agent fixture: fork helper");
            return EXIT_FAILURE;
        }
        if (child == 0) {
            /* Execute the original system sleep; never copy or re-sign it. */
            execl("/bin/sleep", "sleep", "30", (char *)NULL);
            perror("agent fixture: exec sleep");
            _exit(127);
        }
        FILE *file = fopen(argv[2], "w");
        if (file == NULL) {
            perror("agent fixture: open pid file");
            kill(child, SIGKILL);
            wait_for_child(child);
            return EXIT_FAILURE;
        }
        int write_failed = fprintf(file, "%ld\n", (long)child) < 0;
        if (fclose(file) != 0 || write_failed) {
            perror("agent fixture: write pid file");
            kill(child, SIGKILL);
            wait_for_child(child);
            return EXIT_FAILURE;
        }
        return wait_for_child(child);
    }
    if (argc == 2 && strcmp(argv[1], "--wait") == 0) {
        struct timespec remaining = {30, 0};
        while (nanosleep(&remaining, &remaining) < 0) {
            if (errno == EINTR) continue;
            perror("agent fixture: nanosleep");
            return EXIT_FAILURE;
        }
        return EXIT_SUCCESS;
    }
    fputs("agent fixture: unsupported arguments\n", stderr);
    return EXIT_FAILURE;
}
